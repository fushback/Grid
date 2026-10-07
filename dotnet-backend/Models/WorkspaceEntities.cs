using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;

namespace GridPulse.Api.Models;

[Table("workspace_metadata")]
public class WorkspaceMetadataEntity
{
    [Key]
    [Column("id")]
    public string Id { get; set; } = "default_workspace";

    [Required]
    [Column("database_name")]
    public string DatabaseName { get; set; } = "GridPulse_Enterprise_DB";

    [Required]
    [Column("name")]
    public string Name { get; set; } = "Enterprise_Operations_Grid";

    [Column("updated_at")]
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

[Table("workspace_columns")]
public class WorkspaceColumnEntity
{
    [Key]
    [Column("id")]
    public string Id { get; set; } = string.Empty;

    [Column("database_name")]
    public string DatabaseName { get; set; } = "GridPulse_Enterprise_DB";

    [Column("table_name")]
    public string TableName { get; set; } = "Enterprise_Operations_Grid";

    [Required]
    [Column("name")]
    public string Name { get; set; } = string.Empty;

    /// <summary>
    /// Supported types: 'text' | 'varchar_max' | 'number' | 'date' | 'dropdown' | 'lookup' | 'checkbox' | 'formula'
    /// </summary>
    [Required]
    [Column("col_type")]
    public string ColType { get; set; } = "text";

    [Column("order_index")]
    public int OrderIndex { get; set; }

    [Column("width")]
    public int Width { get; set; } = 150;

    [Column("required")]
    public bool Required { get; set; }

    [Column("is_nullable")]
    public bool IsNullable { get; set; } = true;

    [Column("is_primary_key")]
    public bool IsPrimaryKey { get; set; }

    [Column("is_identity")]
    public bool IsIdentity { get; set; }

    [Column("identity_seed")]
    public int IdentitySeed { get; set; } = 1;

    [Column("identity_increment")]
    public int IdentityIncrement { get; set; } = 1;

    [Column("default_value")]
    public string DefaultValue { get; set; } = string.Empty;

    [Column("options_csv")]
    public string OptionsCsv { get; set; } = string.Empty;

    [Column("formula")]
    public string Formula { get; set; } = string.Empty;
}

[Table("workspace_rows")]
public class WorkspaceRowEntity
{
    [Key]
    [Column("id")]
    public string Id { get; set; } = string.Empty;

    [Column("database_name")]
    public string DatabaseName { get; set; } = "GridPulse_Enterprise_DB";

    [Column("table_name")]
    public string TableName { get; set; } = "Enterprise_Operations_Grid";

    [Column("order_index")]
    public double OrderIndex { get; set; }

    /// <summary>
    /// JSONB dictionary mapping Column Name/ID -> cell primitive value (string | number | boolean)
    /// </summary>
    [Column("cells_json", TypeName = "jsonb")]
    public string CellsJson { get; set; } = "{}";

    [Column("updated_by")]
    public string UpdatedBy { get; set; } = "System";

    [Column("updated_at")]
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

[Table("workspace_activities")]
public class WorkspaceActivityEntity
{
    [Key]
    [Column("id")]
    public string Id { get; set; } = string.Empty;

    [Column("user_name")]
    public string UserName { get; set; } = string.Empty;

    [Column("user_color")]
    public string UserColor { get; set; } = "#2563eb";

    [Column("action_type")]
    public string ActionType { get; set; } = string.Empty;

    [Column("action_detail")]
    public string ActionDetail { get; set; } = string.Empty;

    [Column("timestamp")]
    public DateTime Timestamp { get; set; } = DateTime.UtcNow;
}

// ============================================================================
// DTOs for REST API & Real-Time SSE Sync
// ============================================================================

public class GridColumnDto
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string ColType { get; set; } = "text";
    public int OrderIndex { get; set; }
    public int Width { get; set; } = 150;
    public bool Required { get; set; }
    public bool? IsNullable { get; set; } = true;
    public bool? IsPrimaryKey { get; set; }
    public bool? IsIdentity { get; set; }
    public int? IdentitySeed { get; set; }
    public int? IdentityIncrement { get; set; }
    public string? DefaultValue { get; set; }
    public string OptionsCsv { get; set; } = string.Empty;
    public string Formula { get; set; } = string.Empty;
}

public class GridRowDto
{
    public string Id { get; set; } = string.Empty;
    public double OrderIndex { get; set; }
    public Dictionary<string, object?> Cells { get; set; } = new();
    public string UpdatedBy { get; set; } = string.Empty;
    public string UpdatedAt { get; set; } = string.Empty;
}

public class SyncWorkspaceRequestDto
{
    public string? ClientId { get; set; }
    public string? UserName { get; set; }
    public string? UserColor { get; set; }
    public string? ActionType { get; set; }
    public string? ActionDetail { get; set; }
    public string? DatabaseName { get; set; }
    public string? TableName { get; set; }
    public string? WorkspaceName { get; set; }
    public bool? PreserveActiveContext { get; set; }
    public string? ApplyDefaultToAllRowsForColId { get; set; }
    public List<GridColumnDto>? Columns { get; set; }
    public List<GridRowDto>? Rows { get; set; }
    public List<string>? DeletedRowIds { get; set; }
}

public class QueryWorkspaceRequestDto
{
    public string? DatabaseName { get; set; }
    public string? TableName { get; set; }
    public int Offset { get; set; } = 0;
    public int Limit { get; set; } = 100;
    public bool SelectAll { get; set; } = false;
    public string? GlobalSearchQuery { get; set; }
    public string? SearchScopeColId { get; set; }
    public Dictionary<string, string>? ColumnHeaderSearches { get; set; }
}

public class CreateTableRequestDto
{
    public string? DatabaseName { get; set; }
    public string? TableName { get; set; }
    public string? UserName { get; set; }
    public string? UserColor { get; set; }
}

public class GenerateRowsRequestDto
{
    public int Count { get; set; } = 500;
    public string? DatabaseName { get; set; }
    public string? TableName { get; set; }
    public string? UserName { get; set; }
    public string? UserColor { get; set; }
}

public class CollaboratorPresenceDto
{
    public string UserId { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public string Color { get; set; } = "#2563eb";
    public bool IsAnonymous { get; set; } = true;
    public string? ActiveRowId { get; set; }
    public string? ActiveColId { get; set; }
    public string UpdatedAt { get; set; } = DateTime.UtcNow.ToString("O");
}
