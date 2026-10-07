using System.Text.Json;
using GridPulse.Api.Models;
using Microsoft.EntityFrameworkCore;

namespace GridPulse.Api.Data;

public class GridPulseDbContext : DbContext
{
    public GridPulseDbContext(DbContextOptions<GridPulseDbContext> options) : base(options)
    {
    }

    public DbSet<WorkspaceMetadataEntity> WorkspaceMetadata => Set<WorkspaceMetadataEntity>();
    public DbSet<WorkspaceColumnEntity> Columns => Set<WorkspaceColumnEntity>();
    public DbSet<WorkspaceRowEntity> Rows => Set<WorkspaceRowEntity>();
    public DbSet<WorkspaceActivityEntity> Activities => Set<WorkspaceActivityEntity>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);

        modelBuilder.Entity<WorkspaceColumnEntity>()
            .HasIndex(c => new { c.DatabaseName, c.TableName, c.OrderIndex });

        modelBuilder.Entity<WorkspaceRowEntity>()
            .HasIndex(r => new { r.DatabaseName, r.TableName, r.OrderIndex });

        modelBuilder.Entity<WorkspaceActivityEntity>()
            .HasIndex(a => a.Timestamp);
    }

    public static async Task EnsureSeededAsync(GridPulseDbContext db)
    {
        await db.Database.EnsureCreatedAsync();

        if (!await db.WorkspaceMetadata.AnyAsync())
        {
            db.WorkspaceMetadata.Add(new WorkspaceMetadataEntity
            {
                Id = "default_workspace",
                DatabaseName = "GridPulse_Enterprise_DB",
                Name = "Enterprise_Operations_Grid",
                UpdatedAt = DateTime.UtcNow
            });
        }

        if (!await db.Columns.AnyAsync())
        {
            var initialCols = new List<WorkspaceColumnEntity>
            {
                new() { Id = "ID", Name = "ID", ColType = "number", OrderIndex = 0, Width = 96, Required = true, IsNullable = false, IsPrimaryKey = true, IsIdentity = true, IdentitySeed = 1, IdentityIncrement = 1 },
                new() { Id = "col_code", Name = "Record Code", ColType = "text", OrderIndex = 1, Width = 135, Required = true, IsNullable = false },
                new() { Id = "col_title", Name = "Initiative / Task", ColType = "text", OrderIndex = 2, Width = 240, Required = true, IsNullable = false },
                new() { Id = "col_dept", Name = "Department", ColType = "dropdown", OrderIndex = 3, Width = 155, Required = true, IsNullable = false, OptionsCsv = "Engineering, Product, Finance, Operations, Growth, Security" },
                new() { Id = "col_status", Name = "Status", ColType = "dropdown", OrderIndex = 4, Width = 145, Required = true, IsNullable = false, OptionsCsv = "In Progress, Completed, Under Review, Planned, Blocked" },
                new() { Id = "col_owner", Name = "Lead Owner", ColType = "text", OrderIndex = 5, Width = 160, Required = false, IsNullable = true },
                new() { Id = "col_units", Name = "Allocated Units", ColType = "number", OrderIndex = 6, Width = 140, Required = true, IsNullable = false, DefaultValue = "1" },
                new() { Id = "col_unit_cost", Name = "Unit Cost ($)", ColType = "number", OrderIndex = 7, Width = 140, Required = true, IsNullable = false, DefaultValue = "100" },
                new() { Id = "col_total", Name = "Total Budget ($)", ColType = "formula", OrderIndex = 8, Width = 165, Required = false, IsNullable = true, Formula = "=[Allocated Units] * [Unit Cost ($)]" },
                new() { Id = "col_due", Name = "Target Date", ColType = "date", OrderIndex = 9, Width = 140, Required = true, IsNullable = false },
                new() { Id = "col_verified", Name = "Approved", ColType = "checkbox", OrderIndex = 10, Width = 115, Required = false, IsNullable = false, DefaultValue = "false" }
            };
            db.Columns.AddRange(initialCols);
        }

        if (!await db.Rows.AnyAsync())
        {
            var depts = new[] { "Engineering", "Product", "Finance", "Operations", "Growth", "Security" };
            var statuses = new[] { "In Progress", "Completed", "Under Review", "Planned", "Blocked" };
            var owners = new[] { "Elena Rostova", "Marcus Vance", "Aria Chen", "Devon Brooks", "Sora Takahashi", "Liam O'Connor", "Nadia Patel", "Julian Sterling" };
            var prefixes = new[] { "Cloud Migration", "Zero-Trust Auth", "Realtime Grid Engine", "Q4 Revenue Audit", "APAC Expansion", "Latency Reduction", "Data Warehouse Sync", "Customer Portal v3", "AI Indexing Pipeline", "SOC2 Compliance" };

            var rows = new List<WorkspaceRowEntity>(500);
            for (var i = 1; i <= 500; i++)
            {
                var dept = depts[(i * 7) % depts.Length];
                var status = statuses[(i * 3) % statuses.Length];
                var owner = owners[(i * 5) % owners.Length];
                var prefix = prefixes[i % prefixes.Length];
                var units = 5 + ((i * 17) % 195);
                var unitCost = 25 + ((i * 31) % 475);
                var month = 1 + (i % 12);
                var day = 1 + ((i * 3) % 28);
                var approved = i % 3 != 0;
                var code = $"GP-{1000 + i}";
                var title = $"{prefix} — Phase {(i % 4) + 1}.{i % 9}";
                var due = $"2025-{month:D2}-{day:D2}";

                var cells = new Dictionary<string, object?>
                {
                    ["ID"] = i,
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

                rows.Add(new WorkspaceRowEntity
                {
                    Id = $"row_seed_{i}",
                    DatabaseName = "GridPulse_Enterprise_DB",
                    TableName = "Enterprise_Operations_Grid",
                    OrderIndex = i * 10.0,
                    CellsJson = JsonSerializer.Serialize(cells),
                    UpdatedBy = owner,
                    UpdatedAt = DateTime.UtcNow
                });
            }

            db.Rows.AddRange(rows);
            db.Activities.Add(new WorkspaceActivityEntity
            {
                Id = "act_init",
                UserName = "System",
                UserColor = "#2563eb",
                ActionType = "PostgreSQL Seeded",
                ActionDetail = "Initialized 500 enterprise records with ID IDENTITY(1,1) in Supabase PostgreSQL",
                Timestamp = DateTime.UtcNow
            });
        }

        await db.SaveChangesAsync();
    }
}
