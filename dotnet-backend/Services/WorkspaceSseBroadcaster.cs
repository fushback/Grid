using System.Collections.Concurrent;
using System.Text.Json;
using System.Threading.Channels;

namespace GridPulse.Api.Services;

public class WorkspaceSseBroadcaster
{
    private readonly ConcurrentDictionary<Guid, Channel<string>> _clients = new();

    public (Guid ClientId, ChannelReader<string> Reader) Subscribe()
    {
        var id = Guid.NewGuid();
        var channel = Channel.CreateUnbounded<string>();
        _clients[id] = channel;
        return (id, channel.Reader);
    }

    public void Unsubscribe(Guid clientId)
    {
        if (_clients.TryRemove(clientId, out var channel))
        {
            channel.Writer.TryComplete();
        }
    }

    public void BroadcastEvent(string eventName, object payload)
    {
        var json = JsonSerializer.Serialize(payload);
        var message = $"event: {eventName}\ndata: {json}\n\n";

        foreach (var kvp in _clients)
        {
            if (!kvp.Value.Writer.TryWrite(message))
            {
                Unsubscribe(kvp.Key);
            }
        }
    }
}
