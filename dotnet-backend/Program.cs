using GridPulse.Api.Data;
using GridPulse.Api.Services;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

// Configure Supabase PostgreSQL with Entity Framework Core (Npgsql)
var connectionString =
    Environment.GetEnvironmentVariable("SUPABASE_POSTGRES_CONNECTION_STRING") ??
    Environment.GetEnvironmentVariable("POSTGRES_CONNECTION_STRING") ??
    builder.Configuration.GetConnectionString("SupabasePostgreSql") ??
    builder.Configuration.GetConnectionString("PostgreSqlConnection") ??
    "Host=localhost;Port=5432;Database=gridpulse_db;Username=postgres;Password=postgres";

builder.Services.AddDbContext<GridPulseDbContext>(options =>
    options.UseNpgsql(connectionString, npgsqlOptions =>
    {
        npgsqlOptions.EnableRetryOnFailure(
            maxRetryCount: 3,
            maxRetryDelay: TimeSpan.FromSeconds(5),
            errorCodesToAdd: null);
    }));

builder.Services.AddSingleton<WorkspaceSseBroadcaster>();
builder.Services.AddControllers();

builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
    {
        policy.AllowAnyOrigin()
              .AllowAnyHeader()
              .AllowAnyMethod();
    });
});

var app = builder.Build();

// Ensure Supabase PostgreSQL schema and initial 500-row dataset are created on startup
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<GridPulseDbContext>();
    await GridPulseDbContext.EnsureSeededAsync(db);
}

app.UseCors();
app.MapControllers();

app.Run();
