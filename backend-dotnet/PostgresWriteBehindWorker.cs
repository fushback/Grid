using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using GridPulse.Realtime.Contracts;
using GridPulse.Realtime.Infrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Npgsql;
using NpgsqlTypes;

namespace GridPulse.Realtime.Workers;

public sealed class PostgresWriteBehindWorker : BackgroundService
{
    private readonly IRedisGridStateStore _redisStore;
    private readonly ILogger<PostgresWriteBehindWorker> _logger;
    private readonly string _postgresConnectionString;
    private readonly string _workerId = $"{Environment.MachineName}_{Guid.NewGuid():N}"[..24];

    private readonly TimeSpan _checkInterval = TimeSpan.FromSeconds(5);
    private readonly TimeSpan _maxFlushInterval = TimeSpan.FromMinutes(3);
    private const int BufferThresholdRowCount = 500;
    private const int MaxBatchClaimSize = 1000;
    private const int MaxRetryAttempts = 4;

    public PostgresWriteBehindWorker(
        IRedisGridStateStore redisStore,
        IConfiguration configuration,
        ILogger<PostgresWriteBehindWorker> logger)
    {
        _redisStore = redisStore ?? throw new ArgumentNullException(nameof(redisStore));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        _postgresConnectionString = configuration.GetConnectionString("PostgresPrimary")
            ?? throw new InvalidOperationException("Missing ConnectionStrings:PostgresPrimary configuration.");
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation(
            "PostgresWriteBehindWorker [{WorkerId}] started. Threshold={Threshold} rows, MaxAge={MaxAge}s",
            _workerId,
            BufferThresholdRowCount,
            _maxFlushInterval.TotalSeconds
        );

        using var timer = new PeriodicTimer(_checkInterval);

        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken).ConfigureAwait(false))
            {
                await EvaluateAndFlushBufferAsync(forceFlushAll: false, stoppingToken).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            _logger.LogInformation("Graceful shutdown initiated. Draining remaining Redis write-behind buffer...");
            using var drainCts = new CancellationTokenSource(TimeSpan.FromSeconds(25));
            await EvaluateAndFlushBufferAsync(forceFlushAll: true, drainCts.Token).ConfigureAwait(false);
        }
    }

    private async Task EvaluateAndFlushBufferAsync(bool forceFlushAll, CancellationToken ct)
    {
        try
        {
            long dirtyCount = await _redisStore.GetDirtyRowCountAsync().ConfigureAwait(false);
            if (dirtyCount == 0)
            {
                return;
            }

            bool shouldFlush = forceFlushAll || dirtyCount >= BufferThresholdRowCount;

            if (!shouldFlush)
            {
                long? oldestTsMs = await _redisStore.GetOldestDirtyTimestampMsAsync().ConfigureAwait(false);
                if (oldestTsMs.HasValue)
                {
                    long ageMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - oldestTsMs.Value;
                    if (ageMs >= (long)_maxFlushInterval.TotalMilliseconds)
                    {
                        shouldFlush = true;
                    }
                }
            }

            if (!shouldFlush)
            {
                return;
            }

            while (!ct.IsCancellationRequested)
            {
                var (leaseKey, claimedRows) = await _redisStore
                    .ClaimDirtyBatchAsync(_workerId, MaxBatchClaimSize, ct)
                    .ConfigureAwait(false);

                if (claimedRows.Count == 0)
                {
                    break;
                }

                bool persisted = await PersistBatchWithRetryAsync(claimedRows, ct).ConfigureAwait(false);
                if (persisted)
                {
                    await _redisStore.AcknowledgeBatchFlushedAsync(leaseKey).ConfigureAwait(false);
                    _logger.LogInformation(
                        "Flushed {RowCount} coalesced dirty rows from Redis to PostgreSQL (Lease={LeaseKey}).",
                        claimedRows.Count,
                        leaseKey
                    );
                }
                else
                {
                    _logger.LogError(
                        "Exhausted retries flushing batch {LeaseKey}. Re-queueing {RowCount} rows back to Redis.",
                        leaseKey,
                        claimedRows.Count
                    );
                    await _redisStore.RequeueFailedBatchAsync(leaseKey).ConfigureAwait(false);
                    break;
                }

                if (!forceFlushAll && claimedRows.Count < MaxBatchClaimSize)
                {
                    break;
                }
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogError(ex, "Unhandled exception during write-behind buffer evaluation loop.");
        }
    }

    private async Task<bool> PersistBatchWithRetryAsync(
        IReadOnlyList<DirtyRowEnvelope> rows,
        CancellationToken ct)
    {
        for (int attempt = 1; attempt <= MaxRetryAttempts; attempt++)
        {
            try
            {
                await ExecutePostgresBulkUpsertAsync(rows, ct).ConfigureAwait(false);
                return true;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                int backoffMs = (int)(Math.Pow(2, attempt) * 250) + Random.Shared.Next(50, 200);
                _logger.LogWarning(
                    ex,
                    "PostgreSQL bulk upsert attempt {Attempt}/{MaxAttempts} failed for {Count} rows. Retrying in {BackoffMs}ms...",
                    attempt,
                    MaxRetryAttempts,
                    rows.Count,
                    backoffMs
                );
                await Task.Delay(backoffMs, ct).ConfigureAwait(false);
            }
        }
        return false;
    }

    private async Task ExecutePostgresBulkUpsertAsync(
        IReadOnlyList<DirtyRowEnvelope> rows,
        CancellationToken ct)
    {
        const string sql = @"
            CREATE TABLE IF NOT EXISTS public.grid_rows (
                database_name TEXT NOT NULL,
                table_name    TEXT NOT NULL,
                row_id        TEXT NOT NULL,
                cells         JSONB NOT NULL DEFAULT '{}'::jsonb,
                updated_by    TEXT NOT NULL,
                updated_at_ms BIGINT NOT NULL,
                updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (database_name, table_name, row_id)
            );

            INSERT INTO public.grid_rows (
                database_name,
                table_name,
                row_id,
                cells,
                updated_by,
                updated_at_ms,
                updated_at
            )
            SELECT
                u.db_name,
                u.tbl_name,
                u.r_id,
                u.cells_json,
                u.usr_name,
                u.ts_ms,
                to_timestamp(u.ts_ms / 1000.0)
            FROM UNNEST(
                @dbNames::text[],
                @tblNames::text[],
                @rowIds::text[],
                @cellsJson::jsonb[],
                @updatedBys::text[],
                @updatedAtMs::bigint[]
            ) AS u(db_name, tbl_name, r_id, cells_json, usr_name, ts_ms)
            ON CONFLICT (database_name, table_name, row_id)
            DO UPDATE SET
                cells         = public.grid_rows.cells || EXCLUDED.cells,
                updated_by    = CASE
                                    WHEN EXCLUDED.updated_at_ms >= public.grid_rows.updated_at_ms
                                    THEN EXCLUDED.updated_by
                                    ELSE public.grid_rows.updated_by
                                END,
                updated_at_ms = GREATEST(public.grid_rows.updated_at_ms, EXCLUDED.updated_at_ms),
                updated_at    = GREATEST(public.grid_rows.updated_at, EXCLUDED.updated_at);
        ";

        int count = rows.Count;
        var dbNames = new string[count];
        var tblNames = new string[count];
        var rowIds = new string[count];
        var cellsJson = new string[count];
        var updatedBys = new string[count];
        var updatedAtMs = new long[count];

        for (int i = 0; i < count; i++)
        {
            DirtyRowEnvelope r = rows[i];
            dbNames[i] = r.DatabaseName;
            tblNames[i] = r.TableName;
            rowIds[i] = r.RowId;
            cellsJson[i] = JsonSerializer.Serialize(r.Cells);
            updatedBys[i] = r.UpdatedBy;
            updatedAtMs[i] = r.UpdatedAtMs;
        }

        await using var conn = new NpgsqlConnection(_postgresConnectionString);
        await conn.OpenAsync(ct).ConfigureAwait(false);
        await using var tx = await conn.BeginTransactionAsync(ct).ConfigureAwait(false);

        await using var cmd = new NpgsqlCommand(sql, conn, tx)
        {
            CommandTimeout = 30
        };

        cmd.Parameters.Add(new NpgsqlParameter("dbNames", NpgsqlDbType.Array | NpgsqlDbType.Text) { Value = dbNames });
        cmd.Parameters.Add(new NpgsqlParameter("tblNames", NpgsqlDbType.Array | NpgsqlDbType.Text) { Value = tblNames });
        cmd.Parameters.Add(new NpgsqlParameter("rowIds", NpgsqlDbType.Array | NpgsqlDbType.Text) { Value = rowIds });
        cmd.Parameters.Add(new NpgsqlParameter("cellsJson", NpgsqlDbType.Array | NpgsqlDbType.Jsonb) { Value = cellsJson });
        cmd.Parameters.Add(new NpgsqlParameter("updatedBys", NpgsqlDbType.Array | NpgsqlDbType.Text) { Value = updatedBys });
        cmd.Parameters.Add(new NpgsqlParameter("updatedAtMs", NpgsqlDbType.Array | NpgsqlDbType.Bigint) { Value = updatedAtMs });

        await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
        await tx.CommitAsync(ct).ConfigureAwait(false);
    }
}
