using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using GridPulse.Realtime.Contracts;
using Microsoft.Extensions.Logging;
using StackExchange.Redis;

namespace GridPulse.Realtime.Infrastructure;

public interface IRedisGridStateStore
{
    Task<CellAckDto> ApplyCellDeltaAtomicAsync(CellDeltaDto delta, CancellationToken ct = default);
    Task<IReadOnlyList<CellAckDto>> ApplyCellBatchAtomicAsync(IReadOnlyList<CellDeltaDto> deltas, CancellationToken ct = default);
    Task<long> GetDirtyRowCountAsync();
    Task<long?> GetOldestDirtyTimestampMsAsync();
    Task<(string LeaseKey, IReadOnlyList<DirtyRowEnvelope> Rows)> ClaimDirtyBatchAsync(
        string workerId,
        int batchSize,
        CancellationToken ct = default);
    Task AcknowledgeBatchFlushedAsync(string leaseKey);
    Task RequeueFailedBatchAsync(string leaseKey);
}

public sealed class RedisGridStateStore : IRedisGridStateStore
{
    private readonly IConnectionMultiplexer _redis;
    private readonly ILogger<RedisGridStateStore> _logger;

    private const string DirtyIndexZSetKey = "grid:dirty:index";
    private const long MaxClockDriftMs = 30_000;

    private const string UpsertCellLuaScript = @"
        local cellKey = KEYS[1]
        local metaKey = KEYS[2]
        local dirtyZSetKey = KEYS[3]

        local colId = ARGV[1]
        local newVal = ARGV[2]
        local incomingTs = tonumber(ARGV[3])
        local userName = ARGV[4]
        local compositeKey = ARGV[5]
        local ttlSeconds = tonumber(ARGV[6])

        local tsField = colId .. ':ts'
        local userField = colId .. ':usr'

        local currentTsRaw = redis.call('HGET', metaKey, tsField)
        local currentTs = tonumber(currentTsRaw) or 0

        if incomingTs < currentTs then
            local authVal = redis.call('HGET', cellKey, colId) or ''
            local authUsr = redis.call('HGET', metaKey, userField) or ''
            return { 0, authVal, tostring(currentTs), authUsr }
        end

        redis.call('HSET', cellKey, colId, newVal)
        redis.call('HSET', metaKey,
            tsField, tostring(incomingTs),
            userField, userName,
            '_rowUpdatedAt', tostring(incomingTs),
            '_rowUpdatedBy', userName
        )

        redis.call('EXPIRE', cellKey, ttlSeconds)
        redis.call('EXPIRE', metaKey, ttlSeconds)

        redis.call('ZADD', dirtyZSetKey, 'NX', incomingTs, compositeKey)

        return { 1, newVal, tostring(incomingTs), userName }
    ";

    private const string ClaimDirtyBatchLuaScript = @"
        local dirtyZSetKey = KEYS[1]
        local leaseKey = KEYS[2]
        local batchSize = tonumber(ARGV[1])
        local leaseTtl = tonumber(ARGV[2])

        local popped = redis.call('ZPOPMIN', dirtyZSetKey, batchSize)
        if not popped or #popped == 0 then
            return {}
        end

        local results = {}
        for i = 1, #popped, 2 do
            local composite = popped[i]
            local score = popped[i + 1]

            local sep1 = string.find(composite, '|', 1, true)
            local sep2 = string.find(composite, '|', sep1 + 1, true)

            if sep1 and sep2 then
                local dbName = string.sub(composite, 1, sep1 - 1)
                local tblName = string.sub(composite, sep1 + 1, sep2 - 1)
                local rowId = string.sub(composite, sep2 + 1)

                local cellKey = 'grid:cells:' .. dbName .. ':' .. tblName .. ':' .. rowId
                local metaKey = 'grid:meta:' .. dbName .. ':' .. tblName .. ':' .. rowId

                local cellFlat = redis.call('HGETALL', cellKey)
                local updatedBy = redis.call('HGET', metaKey, '_rowUpdatedBy') or 'System'
                local updatedAt = redis.call('HGET', metaKey, '_rowUpdatedAt') or tostring(score)

                local payload = cjson.encode({
                    compositeKey = composite,
                    databaseName = dbName,
                    tableName = tblName,
                    rowId = rowId,
                    cellsFlat = cellFlat,
                    updatedBy = updatedBy,
                    updatedAtMs = tonumber(updatedAt) or 0,
                    originalScore = tonumber(score) or 0
                })

                redis.call('HSET', leaseKey, composite, payload)
                table.insert(results, payload)
            end
        end

        if #results > 0 then
            redis.call('EXPIRE', leaseKey, leaseTtl)
        end

        return results
    ";

    public RedisGridStateStore(IConnectionMultiplexer redis, ILogger<RedisGridStateStore> logger)
    {
        _redis = redis ?? throw new ArgumentNullException(nameof(redis));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async Task<CellAckDto> ApplyCellDeltaAtomicAsync(CellDeltaDto delta, CancellationToken ct = default)
    {
        var db = _redis.GetDatabase();
        long serverNowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        long effectiveTs = Math.Min(
            Math.Max(delta.ClientTimestampMs, serverNowMs - 300_000),
            serverNowMs + MaxClockDriftMs
        );

        string cleanDb = SanitizeSegment(delta.DatabaseName);
        string cleanTbl = SanitizeSegment(delta.TableName);
        string cleanRow = SanitizeSegment(delta.RowId);

        RedisKey cellKey = $"grid:cells:{cleanDb}:{cleanTbl}:{cleanRow}";
        RedisKey metaKey = $"grid:meta:{cleanDb}:{cleanTbl}:{cleanRow}";
        string compositeKey = $"{cleanDb}|{cleanTbl}|{cleanRow}";

        RedisResult rawResult = await db.ScriptEvaluateAsync(
            UpsertCellLuaScript,
            new RedisKey[] { cellKey, metaKey, DirtyIndexZSetKey },
            new RedisValue[]
            {
                delta.ColumnId,
                delta.RawValue ?? string.Empty,
                effectiveTs,
                delta.UserName,
                compositeKey,
                86400
            }
        ).ConfigureAwait(false);

        RedisResult[] arr = (RedisResult[])rawResult!;
        bool accepted = (int)arr[0] == 1;
        string? authVal = (string?)arr[1];
        long authTs = long.TryParse((string?)arr[2], out long parsedTs) ? parsedTs : effectiveTs;
        string authUser = (string?)arr[3] ?? delta.UserName;

        return new CellAckDto(
            MutationId: delta.MutationId,
            Accepted: accepted,
            RowId: delta.RowId,
            ColumnId: delta.ColumnId,
            AuthoritativeValue: authVal,
            AuthoritativeTimestampMs: authTs,
            UpdatedBy: authUser
        );
    }

    public async Task<IReadOnlyList<CellAckDto>> ApplyCellBatchAtomicAsync(
        IReadOnlyList<CellDeltaDto> deltas,
        CancellationToken ct = default)
    {
        var acks = new List<CellAckDto>(deltas.Count);
        foreach (var delta in deltas)
        {
            ct.ThrowIfCancellationRequested();
            var ack = await ApplyCellDeltaAtomicAsync(delta, ct).ConfigureAwait(false);
            acks.Add(ack);
        }
        return acks;
    }

    public async Task<long> GetDirtyRowCountAsync()
    {
        var db = _redis.GetDatabase();
        return await db.SortedSetLengthAsync(DirtyIndexZSetKey).ConfigureAwait(false);
    }

    public async Task<long?> GetOldestDirtyTimestampMsAsync()
    {
        var db = _redis.GetDatabase();
        SortedSetEntry[] entries = await db.SortedSetRangeByRankWithScoresAsync(
            DirtyIndexZSetKey,
            start: 0,
            stop: 0,
            order: Order.Ascending
        ).ConfigureAwait(false);

        if (entries.Length == 0)
        {
            return null;
        }
        return (long)entries[0].Score;
    }

    public async Task<(string LeaseKey, IReadOnlyList<DirtyRowEnvelope> Rows)> ClaimDirtyBatchAsync(
        string workerId,
        int batchSize,
        CancellationToken ct = default)
    {
        var db = _redis.GetDatabase();
        string batchId = Guid.NewGuid().ToString("N");
        string leaseKey = $"grid:inflight:{workerId}:{batchId}";

        RedisResult raw = await db.ScriptEvaluateAsync(
            ClaimDirtyBatchLuaScript,
            new RedisKey[] { DirtyIndexZSetKey, leaseKey },
            new RedisValue[] { batchSize, 600 }
        ).ConfigureAwait(false);

        if (raw.IsNull)
        {
            return (leaseKey, Array.Empty<DirtyRowEnvelope>());
        }

        RedisResult[] items = (RedisResult[])raw!;
        var envelopes = new List<DirtyRowEnvelope>(items.Length);

        foreach (RedisResult item in items)
        {
            string? json = (string?)item;
            if (string.IsNullOrWhiteSpace(json)) continue;

            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;

            string compositeKey = root.GetProperty("compositeKey").GetString() ?? string.Empty;
            string dbName = root.GetProperty("databaseName").GetString() ?? string.Empty;
            string tblName = root.GetProperty("tableName").GetString() ?? string.Empty;
            string rowId = root.GetProperty("rowId").GetString() ?? string.Empty;
            string updatedBy = root.GetProperty("updatedBy").GetString() ?? "System";
            long updatedAtMs = root.GetProperty("updatedAtMs").GetInt64();

            var cellsDict = new Dictionary<string, string?>(StringComparer.Ordinal);
            if (root.TryGetProperty("cellsFlat", out JsonElement cellsFlat) &&
                cellsFlat.ValueKind == JsonValueKind.Array)
            {
                var flatEnum = cellsFlat.EnumerateArray();
                while (flatEnum.MoveNext())
                {
                    string fieldName = flatEnum.Current.GetString() ?? string.Empty;
                    if (!flatEnum.MoveNext()) break;
                    string? fieldVal = flatEnum.Current.GetString();
                    if (!string.IsNullOrEmpty(fieldName))
                    {
                        cellsDict[fieldName] = fieldVal;
                    }
                }
            }

            if (cellsDict.Count > 0)
            {
                envelopes.Add(new DirtyRowEnvelope(
                    CompositeKey: compositeKey,
                    DatabaseName: dbName,
                    TableName: tblName,
                    RowId: rowId,
                    Cells: cellsDict,
                    UpdatedBy: updatedBy,
                    UpdatedAtMs: updatedAtMs
                ));
            }
        }

        return (leaseKey, envelopes);
    }

    public async Task AcknowledgeBatchFlushedAsync(string leaseKey)
    {
        var db = _redis.GetDatabase();
        await db.KeyDeleteAsync(leaseKey).ConfigureAwait(false);
    }

    public async Task RequeueFailedBatchAsync(string leaseKey)
    {
        var db = _redis.GetDatabase();
        HashEntry[] leaseEntries = await db.HashGetAllAsync(leaseKey).ConfigureAwait(false);
        if (leaseEntries.Length == 0) return;

        var batch = db.CreateBatch();
        var tasks = new List<Task>(leaseEntries.Length + 1);
        long fallbackScore = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        foreach (HashEntry entry in leaseEntries)
        {
            string compositeKey = entry.Name.ToString();
            long score = fallbackScore;
            try
            {
                using var doc = JsonDocument.Parse(entry.Value.ToString());
                if (doc.RootElement.TryGetProperty("originalScore", out JsonElement scoreEl))
                {
                    score = scoreEl.GetInt64();
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Could not parse originalScore for {CompositeKey}", compositeKey);
            }

            tasks.Add(batch.SortedSetAddAsync(DirtyIndexZSetKey, compositeKey, score, When.NotExists));
        }

        tasks.Add(batch.KeyDeleteAsync(leaseKey));
        batch.Execute();
        await Task.WhenAll(tasks).ConfigureAwait(false);
    }

    private static string SanitizeSegment(string input)
    {
        if (string.IsNullOrWhiteSpace(input)) return "default";
        return input.Trim().Replace("|", "_").Replace(":", "_");
    }
}
