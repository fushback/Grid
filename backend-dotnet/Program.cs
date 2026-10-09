using System;
using GridPulse.Realtime.Hubs;
using GridPulse.Realtime.Infrastructure;
using GridPulse.Realtime.Workers;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using StackExchange.Redis;

var builder = WebApplication.CreateBuilder(args);

string redisConnStr = builder.Configuration.GetConnectionString("Redis")
    ?? "localhost:6379,abortConnect=false";

builder.Services.AddSingleton<IConnectionMultiplexer>(_ =>
    ConnectionMultiplexer.Connect(redisConnStr));

builder.Services.AddSingleton<IRedisGridStateStore, RedisGridStateStore>();
builder.Services.AddHostedService<PostgresWriteBehindWorker>();

builder.Services
    .AddSignalR(options =>
    {
        options.EnableDetailedErrors = false;
        options.MaximumReceiveMessageSize = 256 * 1024;
        options.KeepAliveInterval = TimeSpan.FromSeconds(10);
        options.ClientTimeoutInterval = TimeSpan.FromSeconds(30);
    })
    .AddStackExchangeRedis(redisConnStr, options =>
    {
        options.Configuration.ChannelPrefix = RedisChannel.Literal("GridPulseSignalR");
    });

var app = builder.Build();

app.MapHub<GridSyncHub>("/hubs/grid-sync");
app.Run();
