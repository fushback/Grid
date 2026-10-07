using System.Collections.Concurrent;
using System.Text.Json;
using GridPulse.Api.Data;
using GridPulse.Api.Models;
using GridPulse.Api.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace GridPulse.Api.Controllers;

[ApiController]
[Route("api")]
public class WorkspaceController : ControllerBase
{
    private readonly GridPulseDbContext _db;
    private readonly WorkspaceSseBroadcaster _broadcaster;

    private static readonly ConcurrentDictionary<string, CollaboratorPresenceDto> ActivePresence = new();

    public WorkspaceController(GridPulseDbContext db, WorkspaceSseBroadcaster broadcaster)
    {
        _db = db;
        _broadcaster = broadcaster;
    }

    private static object ResolveColumnDefaultValue(WorkspaceColumnEntity col)
    {
        var trimmed = (col.DefaultValue ?? string.Empty).Trim();
        if (col.ColType == "checkbox")
        {
            return trimmed.Equals("true", StringComparison.OrdinalIgnoreCase) || trimmed == "1" || trimmed.Equals("yes", StringComparison.OrdinalIgnoreCase);
        }
        if (col.ColType == "number")
        {
            if (trimmed.Length > 0 && double.TryParse(trimmed, out var parsed))
            {
                return parsed;
            }
            return col.Required ? 0 : string.Empty;
        }
        if (col.ColType == "date")
        {
            if (trimmed.Length > 0) return trimmed;
            return col.Required ? DateTime.UtcNow.ToString("yyyy-MM-dd") : string.Empty;
        }
        if (col.ColType == "dropdown")
        {
            var opts = (col.OptionsCsv ?? string.Empty)
                .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            if (trimmed.Length > 0)
            {
                var match = opts.FirstOrDefault(o => o.Equals(trimmed, StringComparison.OrdinalIgnoreCase));
                return match ?? trimmed;
            }
            return col.Required && opts.Length > 0 ? opts[0] : string.Empty;
        }
        if (col.ColType == "lookup")
        {
            return trimmed;
        }
        if (col.ColType == "varchar_max" || col.ColType == "text")
        {
            if (trimmed.Length > 2000) return trimmed[..2000];
            if (trimmed.Length > 0) return trimmed;
            return col.Required ? "TBD" : string.Empty;
        }
        return trimmed;
    }

    private static GridColumnDto MapColumnDto(WorkspaceColumnEntity c) => new()
    {
        Id = c.Id,
        Name = c.Name,
        ColType = c.ColType,
        OrderIndex = c.OrderIndex,
        Width = c.Width,
        Required = c.Required,
        IsNullable = c.IsNullable,
        IsPrimaryKey = c.IsPrimaryKey,
        IsIdentity = c.IsIdentity,
        IdentitySeed = c.IdentitySeed,
        IdentityIncrement = c.IdentityIncrement,
        DefaultValue = c.DefaultValue,
        OptionsCsv = c.OptionsCsv,
        Formula = c.Formula
    };

    [HttpGet("workspace")]
    public async Task<IActionResult> GetWorkspace([FromQuery] int limit = 100)
    {
        var meta = await _db.WorkspaceMetadata.FirstOrDefaultAsync(m => m.Id == "default_workspace");
        var activeDb = meta?.DatabaseName ?? "GridPulse_Enterprise_DB";
        var activeTable = meta?.Name ?? "Enterprise_Operations_Grid";

        var columns = await _db.Columns
            .Where(c => c.DatabaseName == activeDb && c.TableName == activeTable)
            .OrderBy(c => c.OrderIndex)
            .Select(c => MapColumnDto(c))
            .ToListAsync();

        var totalRows = await _db.Rows.CountAsync(r => r.DatabaseName == activeDb && r.TableName == activeTable);
        var rowEntities = await _db.Rows
            .Where(r => r.DatabaseName == activeDb && r.TableName == activeTable)
            .OrderBy(r => r.OrderIndex)
            .Take(Math.Clamp(limit, 1, 50000))
            .ToListAsync();

        var rows = rowEntities.Select(r => new GridRowDto
        {
            Id = r.Id,
            OrderIndex = r.OrderIndex,
            Cells = JsonSerializer.Deserialize<Dictionary<string, object?>>(r.CellsJson) ?? new(),
            UpdatedBy = r.UpdatedBy,
            UpdatedAt = r.UpdatedAt.ToString("O")
        }).ToList();

        var activities = await _db.Activities
            .OrderByDescending(a => a.Timestamp)
            .Take(35)
            .Select(a => new
            {
                id = a.Id,
                userName = a.UserName,
                userColor = a.UserColor,
                actionType = a.ActionType,
                actionDetail = a.ActionDetail,
                timestamp = a.Timestamp.ToString("O")
            })
            .ToListAsync();

        return Ok(new
        {
            activeDatabaseName = activeDb,
            activeTableName = activeTable,
            workspaceName = activeTable,
            updatedAt = (meta?.UpdatedAt ?? DateTime.UtcNow).ToString("O"),
            columns,
            rows,
            totalRows,
            filteredTotalRows = totalRows,
            hasMore = rows.Count < totalRows,
            activities,
            presence = ActivePresence.Values.ToList()
        });
    }

    [HttpPost("workspace/query")]
    public async Task<IActionResult> QueryWorkspace([FromBody] QueryWorkspaceRequestDto req)
    {
        var meta = await _db.WorkspaceMetadata.FirstOrDefaultAsync(m => m.Id == "default_workspace");
        var targetDb = !string.IsNullOrWhiteSpace(req.DatabaseName) ? req.DatabaseName.Trim() : (meta?.DatabaseName ?? "GridPulse_Enterprise_DB");
        var targetTable = !string.IsNullOrWhiteSpace(req.TableName) ? req.TableName.Trim() : (meta?.Name ?? "Enterprise_Operations_Grid");

        var columns = await _db.Columns
            .Where(c => c.DatabaseName == targetDb && c.TableName == targetTable)
            .OrderBy(c => c.OrderIndex)
            .Select(c => MapColumnDto(c))
            .ToListAsync();

        var allTableRows = await _db.Rows
            .Where(r => r.DatabaseName == targetDb && r.TableName == targetTable)
            .OrderBy(r => r.OrderIndex)
            .ToListAsync();

        var totalRows = allTableRows.Count;
        var effectiveOffset = req.SelectAll ? 0 : Math.Max(0, req.Offset);
        var effectiveLimit = req.SelectAll
            ? Math.Max(totalRows, 50000)
            : Math.Clamp(req.Limit > 0 ? req.Limit : 100, 1, 50000);

        var pagedEntities = allTableRows
            .Skip(effectiveOffset)
            .Take(effectiveLimit)
            .ToList();

        var rows = pagedEntities.Select(r => new GridRowDto
        {
            Id = r.Id,
            OrderIndex = r.OrderIndex,
            Cells = JsonSerializer.Deserialize<Dictionary<string, object?>>(r.CellsJson) ?? new(),
            UpdatedBy = r.UpdatedBy,
            UpdatedAt = r.UpdatedAt.ToString("O")
        }).ToList();

        return Ok(new
        {
            ok = true,
            activeDatabaseName = targetDb,
            activeTableName = targetTable,
            columns,
            rows,
            totalRows,
            filteredTotalRows = totalRows,
            offset = effectiveOffset,
            limit = effectiveLimit,
            hasMore = effectiveOffset + rows.Count < totalRows
        });
    }

    [HttpPost("workspace/tables/create")]
    public async Task<IActionResult> CreateTable([FromBody] CreateTableRequestDto req)
    {
        var targetDb = !string.IsNullOrWhiteSpace(req.DatabaseName) ? req.DatabaseName.Trim() : "GridPulse_Enterprise_DB";
        var tableName = (req.TableName ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(tableName))
        {
            return BadRequest(new { ok = false, error = "Table name is required." });
        }

        var exists = await _db.Columns.AnyAsync(c => c.DatabaseName == targetDb && c.TableName.ToLower() == tableName.ToLower());
        if (exists)
        {
            return Conflict(new { ok = false, error = $"Table \"{tableName}\" already exists in database \"{targetDb}\"." });
        }

        // Create table with internal Primary Key ID column (IDENTITY(1,1)) and 0 initial rows
        var pkCol = new WorkspaceColumnEntity
        {
            Id = "ID",
            DatabaseName = targetDb,
            TableName = tableName,
            Name = "ID",
            ColType = "number",
            OrderIndex = 0,
            Width = 96,
            Required = true,
            IsNullable = false,
            IsPrimaryKey = true,
            IsIdentity = true,
            IdentitySeed = 1,
            IdentityIncrement = 1,
            DefaultValue = string.Empty,
            OptionsCsv = string.Empty,
            Formula = string.Empty
        };

        _db.Columns.Add(pkCol);

        var meta = await _db.WorkspaceMetadata.FirstOrDefaultAsync(m => m.Id == "default_workspace");
        if (meta != null)
        {
            meta.DatabaseName = targetDb;
            meta.Name = tableName;
            meta.UpdatedAt = DateTime.UtcNow;
        }

        _db.Activities.Add(new WorkspaceActivityEntity
        {
            Id = $"act_{Guid.NewGuid():N}",
            UserName = req.UserName ?? "Collaborator",
            UserColor = req.UserColor ?? "#2563eb",
            ActionType = "Table Created",
            ActionDetail = $"Created table \"{targetDb}.{tableName}\" (ID IDENTITY(1,1), 0 rows)",
            Timestamp = DateTime.UtcNow
        });

        await _db.SaveChangesAsync();

        return Ok(new
        {
            ok = true,
            activeDatabaseName = targetDb,
            activeTableName = tableName,
            columns = new List<GridColumnDto> { MapColumnDto(pkCol) },
            rows = new List<GridRowDto>(),
            totalRows = 0,
            filteredTotalRows = 0,
            hasMore = false
        });
    }

    [HttpPost("workspace/sync")]
    public async Task<IActionResult> SyncWorkspace([FromBody] SyncWorkspaceRequestDto req)
    {
        await using var tx = await _db.Database.BeginTransactionAsync();

        var meta = await _db.WorkspaceMetadata.FirstOrDefaultAsync(m => m.Id == "default_workspace");
        var targetDb = !string.IsNullOrWhiteSpace(req.DatabaseName) ? req.DatabaseName.Trim() : (meta?.DatabaseName ?? "GridPulse_Enterprise_DB");
        var targetTable = !string.IsNullOrWhiteSpace(req.TableName) ? req.TableName.Trim() : (!string.IsNullOrWhiteSpace(req.WorkspaceName) ? req.WorkspaceName.Trim() : (meta?.Name ?? "Enterprise_Operations_Grid"));

        if (meta != null && req.PreserveActiveContext != true)
        {
            meta.DatabaseName = targetDb;
            meta.Name = targetTable;
            meta.UpdatedAt = DateTime.UtcNow;
        }

        var existingCols = await _db.Columns
            .Where(c => c.DatabaseName == targetDb && c.TableName == targetTable)
            .ToListAsync();
        var existingColIds = new HashSet<string>(existingCols.Select(c => c.Id), StringComparer.OrdinalIgnoreCase);

        var updatedColEntities = new List<WorkspaceColumnEntity>();
        if (req.Columns != null)
        {
            _db.Columns.RemoveRange(existingCols);
            updatedColEntities = req.Columns.Select(c => new WorkspaceColumnEntity
            {
                Id = c.Id,
                DatabaseName = targetDb,
                TableName = targetTable,
                Name = c.Name,
                ColType = c.ColType,
                OrderIndex = c.OrderIndex,
                Width = c.Width,
                Required = c.Required,
                IsNullable = c.IsNullable ?? !c.Required,
                IsPrimaryKey = c.IsPrimaryKey ?? false,
                IsIdentity = c.IsIdentity ?? false,
                IdentitySeed = c.IdentitySeed ?? 1,
                IdentityIncrement = c.IdentityIncrement ?? 1,
                DefaultValue = c.DefaultValue ?? string.Empty,
                OptionsCsv = c.OptionsCsv ?? string.Empty,
                Formula = c.Formula ?? string.Empty
            }).ToList();
            _db.Columns.AddRange(updatedColEntities);
        }
        else
        {
            updatedColEntities = existingCols;
        }

        // Load all existing rows for this table so partial/lazy-loaded syncs preserve non-loaded rows
        // and full-table default value updates apply across the entire database table
        var allTableRows = await _db.Rows
            .Where(r => r.DatabaseName == targetDb && r.TableName == targetTable)
            .ToListAsync();
        var rowMap = allTableRows.ToDictionary(r => r.Id, r => r);

        if (req.DeletedRowIds != null && req.DeletedRowIds.Count > 0)
        {
            foreach (var delId in req.DeletedRowIds)
            {
                if (rowMap.TryGetValue(delId, out var delRow))
                {
                    _db.Rows.Remove(delRow);
                    rowMap.Remove(delId);
                }
            }
        }

        if (req.Rows != null && req.Rows.Count > 0)
        {
            foreach (var r in req.Rows)
            {
                var updatedAt = DateTime.TryParse(r.UpdatedAt, out var parsed) ? parsed.ToUniversalTime() : DateTime.UtcNow;
                if (rowMap.TryGetValue(r.Id, out var existingRow))
                {
                    existingRow.OrderIndex = r.OrderIndex;
                    existingRow.CellsJson = JsonSerializer.Serialize(r.Cells);
                    existingRow.UpdatedBy = string.IsNullOrWhiteSpace(r.UpdatedBy) ? (req.UserName ?? "Collaborator") : r.UpdatedBy;
                    existingRow.UpdatedAt = updatedAt;
                }
                else
                {
                    var newEntity = new WorkspaceRowEntity
                    {
                        Id = r.Id,
                        DatabaseName = targetDb,
                        TableName = targetTable,
                        OrderIndex = r.OrderIndex,
                        CellsJson = JsonSerializer.Serialize(r.Cells),
                        UpdatedBy = string.IsNullOrWhiteSpace(r.UpdatedBy) ? (req.UserName ?? "Collaborator") : r.UpdatedBy,
                        UpdatedAt = updatedAt
                    };
                    _db.Rows.Add(newEntity);
                    rowMap[r.Id] = newEntity;
                }
            }
        }

        // Apply default value across ALL rows in the database table when a column is created or its default value is updated
        var newlyAddedCols = updatedColEntities
            .Where(c => !existingColIds.Contains(c.Id) && !c.IsPrimaryKey && !c.IsIdentity && c.ColType != "formula")
            .ToList();
        var explicitDefaultCols = !string.IsNullOrWhiteSpace(req.ApplyDefaultToAllRowsForColId)
            ? updatedColEntities.Where(c =>
                (c.Id.Equals(req.ApplyDefaultToAllRowsForColId, StringComparison.OrdinalIgnoreCase) ||
                 c.Name.Equals(req.ApplyDefaultToAllRowsForColId, StringComparison.OrdinalIgnoreCase)) &&
                !c.IsPrimaryKey && !c.IsIdentity && c.ColType != "formula").ToList()
            : new List<WorkspaceColumnEntity>();

        var colsToBackfill = newlyAddedCols
            .Concat(explicitDefaultCols)
            .GroupBy(c => c.Id, StringComparer.OrdinalIgnoreCase)
            .Select(g => g.First())
            .ToList();

        if (colsToBackfill.Count > 0)
        {
            foreach (var rowEntity in rowMap.Values)
            {
                var cells = JsonSerializer.Deserialize<Dictionary<string, object?>>(rowEntity.CellsJson) ?? new();
                foreach (var col in colsToBackfill)
                {
                    var defVal = ResolveColumnDefaultValue(col);
                    cells[col.Name] = defVal;
                    cells[col.Id] = defVal;
                }
                rowEntity.CellsJson = JsonSerializer.Serialize(cells);
            }
        }

        if (!string.IsNullOrWhiteSpace(req.ActionType))
        {
            _db.Activities.Add(new WorkspaceActivityEntity
            {
                Id = $"act_{Guid.NewGuid():N}",
                UserName = req.UserName ?? "Collaborator",
                UserColor = req.UserColor ?? "#2563eb",
                ActionType = req.ActionType!,
                ActionDetail = req.ActionDetail ?? string.Empty,
                Timestamp = DateTime.UtcNow
            });
        }

        await _db.SaveChangesAsync();
        await tx.CommitAsync();

        var updatedAtIso = DateTime.UtcNow.ToString("O");
        var totalRows = rowMap.Count;
        var latestActivities = await _db.Activities
            .OrderByDescending(a => a.Timestamp)
            .Take(35)
            .ToListAsync();

        _broadcaster.BroadcastEvent("workspace_sync", new
        {
            clientId = req.ClientId,
            activeDatabaseName = targetDb,
            activeTableName = targetTable,
            workspaceName = targetTable,
            updatedAt = updatedAtIso,
            totalRows,
            activities = latestActivities
        });

        return Ok(new
        {
            ok = true,
            activeDatabaseName = targetDb,
            activeTableName = targetTable,
            updatedAt = updatedAtIso,
            totalRows,
            activities = latestActivities
        });
    }

    [HttpPost("workspace/generate-rows")]
    public async Task<IActionResult> GenerateRows([FromBody] GenerateRowsRequestDto req)
    {
        var count = Math.Clamp(req.Count, 1, 2500);
        var meta = await _db.WorkspaceMetadata.FirstOrDefaultAsync(m => m.Id == "default_workspace");
        var targetDb = !string.IsNullOrWhiteSpace(req.DatabaseName) ? req.DatabaseName.Trim() : (meta?.DatabaseName ?? "GridPulse_Enterprise_DB");
        var targetTable = !string.IsNullOrWhiteSpace(req.TableName) ? req.TableName.Trim() : (meta?.Name ?? "Enterprise_Operations_Grid");

        var existingCount = await _db.Rows.CountAsync(r => r.DatabaseName == targetDb && r.TableName == targetTable);
        var maxOrder = await _db.Rows
            .Where(r => r.DatabaseName == targetDb && r.TableName == targetTable)
            .MaxAsync(r => (double?)r.OrderIndex) ?? 0.0;

        var depts = new[] { "Engineering", "Product", "Finance", "Operations", "Growth", "Security" };
        var statuses = new[] { "In Progress", "Completed", "Under Review", "Planned", "Blocked" };
        var owners = new[] { "Elena Rostova", "Marcus Vance", "Aria Chen", "Devon Brooks", "Sora Takahashi", "Liam O'Connor" };

        var newRows = new List<WorkspaceRowEntity>(count);
        for (var i = 1; i <= count; i++)
        {
            var seq = existingCount + i;
            var code = $"GP-{1000 + seq}";
            var title = $"Batch Operation Record #{seq}";
            var dept = depts[seq % depts.Length];
            var status = statuses[seq % statuses.Length];
            var owner = owners[seq % owners.Length];
            var units = 10 + ((seq * 13) % 150);
            var unitCost = 50 + ((seq * 29) % 450);
            var due = $"2025-{(seq % 12) + 1:D2}-{(seq % 28) + 1:D2}";
            var approved = seq % 2 == 0;

            var cells = new Dictionary<string, object?>
            {
                ["ID"] = seq,
                ["Record Code"] = code,
                ["col_code"] = code,
                ["Initiative / Task"] = title,
                ["col_title"] = title,
                ["Department"] = dept,
                ["col_dept"] = dept,
                ["Status"] = status,
                ["col_status"] = status,
                ["Lead Owner"] = owner,
                ["col_owner"] = owner,
                ["Allocated Units"] = units,
                ["col_units"] = units,
                ["Unit Cost ($)"] = unitCost,
                ["col_unit_cost"] = unitCost,
                ["Target Date"] = due,
                ["col_due"] = due,
                ["Approved"] = approved,
                ["col_verified"] = approved
            };

            newRows.Add(new WorkspaceRowEntity
            {
                Id = $"row_gen_{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}_{i}",
                DatabaseName = targetDb,
                TableName = targetTable,
                OrderIndex = maxOrder + (i * 10.0),
                CellsJson = JsonSerializer.Serialize(cells),
                UpdatedBy = req.UserName ?? "Batch Generator",
                UpdatedAt = DateTime.UtcNow
            });
        }

        _db.Rows.AddRange(newRows);
        _db.Activities.Add(new WorkspaceActivityEntity
        {
            Id = $"act_{Guid.NewGuid():N}",
            UserName = req.UserName ?? "Collaborator",
            UserColor = req.UserColor ?? "#2563eb",
            ActionType = "Bulk Rows Generated",
            ActionDetail = $"Appended {count} rows into Supabase PostgreSQL table \"{targetDb}.{targetTable}\"",
            Timestamp = DateTime.UtcNow
        });

        await _db.SaveChangesAsync();
        return await GetWorkspace();
    }

    [HttpPost("workspace/presence")]
    public IActionResult UpdatePresence([FromBody] CollaboratorPresenceDto dto)
    {
        if (string.IsNullOrWhiteSpace(dto.UserId)) return BadRequest();
        dto.UpdatedAt = DateTime.UtcNow.ToString("O");
        ActivePresence[dto.UserId] = dto;

        _broadcaster.BroadcastEvent("presence", new
        {
            presence = ActivePresence.Values.ToList()
        });

        return Ok(new { ok = true });
    }

    [HttpGet("stream")]
    public async Task StreamEvents(CancellationToken cancellationToken)
    {
        Response.Headers.Append("Content-Type", "text/event-stream");
        Response.Headers.Append("Cache-Control", "no-cache");
        Response.Headers.Append("Connection", "keep-alive");

        var (clientId, reader) = _broadcaster.Subscribe();
        try
        {
            await Response.WriteAsync($"event: connected\ndata: {{\"status\":\"live\"}}\n\n", cancellationToken);
            await Response.Body.FlushAsync(cancellationToken);

            await foreach (var msg in reader.ReadAllAsync(cancellationToken))
            {
                await Response.WriteAsync(msg, cancellationToken);
                await Response.Body.FlushAsync(cancellationToken);
            }
        }
        catch (OperationCanceledException)
        {
            // Client disconnected
        }
        finally
        {
            _broadcaster.Unsubscribe(clientId);
        }
    }
}
