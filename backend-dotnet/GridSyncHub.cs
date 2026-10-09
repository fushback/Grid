using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using GridPulse.Realtime.Contracts;
using GridPulse.Realtime.Infrastructure;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging;

namespace GridPulse.Realtime.Hubs;

public interface IGridSyncClient
{
    Task ReceiveCellDelta(CellDeltaDto delta);
    Task ReceiveCellDeltaBatch(IReadOnlyList<CellDeltaDto> deltas);
    Task ReceiveCellReconciliation(CellAckDto reconciliation);
    Task CollaboratorJoined(string connectionId, string databaseName, string tableName);
    Task CollaboratorLeft(string connectionId, string databaseName, string tableName);
}

public sealed class GridSyncHub : Hub<IGridSyncClient>
{
    private readonly IRedisGridStateStore _redisStore;
    private readonly ILogger<GridSyncHub> _logger;

    public GridSyncHub(IRedisGridStateStore redisStore, ILogger<GridSyncHub> logger)
    {
        _redisStore = redisStore ?? throw new ArgumentNullException(nameof(redisStore));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async Task JoinTableGroup(string databaseName, string tableName)
    {
        string groupKey = BuildGroupKey(databaseName, tableName);
        await Groups.AddToGroupAsync(Context.ConnectionId, groupKey).ConfigureAwait(false);
        await Clients.OthersInGroup(groupKey)
            .CollaboratorJoined(Context.ConnectionId, databaseName, tableName)
            .ConfigureAwait(false);
    }

    public async Task LeaveTableGroup(string databaseName, string tableName)
    {
        string groupKey = BuildGroupKey(databaseName, tableName);
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, groupKey).ConfigureAwait(false);
        await Clients.OthersInGroup(groupKey)
            .CollaboratorLeft(Context.ConnectionId, databaseName, tableName)
            .ConfigureAwait(false);
    }

    public async Task<CellAckDto> StreamCellDelta(CellDeltaDto delta)
    {
        ValidateDelta(delta);

        CellAckDto ack = await _redisStore
            .ApplyCellDeltaAtomicAsync(delta, Context.ConnectionAborted)
            .ConfigureAwait(false);

        string groupKey = BuildGroupKey(delta.DatabaseName, delta.TableName);

        if (ack.Accepted)
        {
            var canonicalDelta = delta with
            {
                ClientTimestampMs = ack.AuthoritativeTimestampMs
            };
            await Clients.OthersInGroup(groupKey)
                .ReceiveCellDelta(canonicalDelta)
                .ConfigureAwait(false);
        }
        else
        {
            await Clients.Caller
                .ReceiveCellReconciliation(ack)
                .ConfigureAwait(false);
        }

        return ack;
    }

    public async Task<IReadOnlyList<CellAckDto>> StreamCellDeltaBatch(CellDeltaBatchDto batch)
    {
        if (batch?.Deltas is null || batch.Deltas.Count == 0)
        {
            return Array.Empty<CellAckDto>();
        }

        foreach (var d in batch.Deltas)
        {
            ValidateDelta(d);
        }

        IReadOnlyList<CellAckDto> acks = await _redisStore
            .ApplyCellBatchAtomicAsync(batch.Deltas, Context.ConnectionAborted)
            .ConfigureAwait(false);

        var acceptedByGroup = new Dictionary<string, List<CellDeltaDto>>(StringComparer.OrdinalIgnoreCase);

        for (int i = 0; i < batch.Deltas.Count; i++)
        {
            var delta = batch.Deltas[i];
            var ack = acks[i];

            if (ack.Accepted)
            {
                string groupKey = BuildGroupKey(delta.DatabaseName, delta.TableName);
                if (!acceptedByGroup.TryGetValue(groupKey, out var list))
                {
                    list = new List<CellDeltaDto>();
                    acceptedByGroup[groupKey] = list;
                }
                list.Add(delta with { ClientTimestampMs = ack.AuthoritativeTimestampMs });
            }
            else
            {
                await Clients.Caller
                    .ReceiveCellReconciliation(ack)
                    .ConfigureAwait(false);
            }
        }

        foreach (var kvp in acceptedByGroup)
        {
            await Clients.OthersInGroup(kvp.Key)
                .ReceiveCellDeltaBatch(kvp.Value)
                .ConfigureAwait(false);
        }

        return acks;
    }

    private static void ValidateDelta(CellDeltaDto delta)
    {
        if (delta is null)
            throw new HubException("Cell delta payload cannot be null.");
        if (string.IsNullOrWhiteSpace(delta.DatabaseName) ||
            string.IsNullOrWhiteSpace(delta.TableName) ||
            string.IsNullOrWhiteSpace(delta.RowId) ||
            string.IsNullOrWhiteSpace(delta.ColumnId))
        {
            throw new HubException("DatabaseName, TableName, RowId, and ColumnId are required.");
        }
    }

    private static string BuildGroupKey(string databaseName, string tableName) =>
        $"grid:{databaseName.Trim().ToLowerInvariant()}:{tableName.Trim().ToLowerInvariant()}";
}
