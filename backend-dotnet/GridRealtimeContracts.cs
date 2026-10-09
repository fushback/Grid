using System;
using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace GridPulse.Realtime.Contracts;

public sealed record CellDeltaDto(
    [property: JsonPropertyName("mutationId")] string MutationId,
    [property: JsonPropertyName("databaseName")] string DatabaseName,
    [property: JsonPropertyName("tableName")] string TableName,
    [property: JsonPropertyName("rowId")] string RowId,
    [property: JsonPropertyName("columnId")] string ColumnId,
    [property: JsonPropertyName("rawValue")] string? RawValue,
    [property: JsonPropertyName("userId")] string UserId,
    [property: JsonPropertyName("userName")] string UserName,
    [property: JsonPropertyName("userColor")] string UserColor,
    [property: JsonPropertyName("clientTimestampMs")] long ClientTimestampMs
);

public sealed record CellDeltaBatchDto(
    [property: JsonPropertyName("deltas")] IReadOnlyList<CellDeltaDto> Deltas
);

public sealed record CellAckDto(
    [property: JsonPropertyName("mutationId")] string MutationId,
    [property: JsonPropertyName("accepted")] bool Accepted,
    [property: JsonPropertyName("rowId")] string RowId,
    [property: JsonPropertyName("columnId")] string ColumnId,
    [property: JsonPropertyName("authoritativeValue")] string? AuthoritativeValue,
    [property: JsonPropertyName("authoritativeTimestampMs")] long AuthoritativeTimestampMs,
    [property: JsonPropertyName("updatedBy")] string UpdatedBy
);

public sealed record DirtyRowEnvelope(
    string CompositeKey,
    string DatabaseName,
    string TableName,
    string RowId,
    IReadOnlyDictionary<string, string?> Cells,
    string UpdatedBy,
    long UpdatedAtMs
);
