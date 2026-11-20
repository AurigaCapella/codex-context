using System.IO;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace CodexContext;

internal sealed class ContextClient(int port) : IDisposable
{
    private readonly HttpClient http = new(new SocketsHttpHandler { UseProxy = false })
    {
        BaseAddress = new Uri($"http://127.0.0.1:{port}"),
        Timeout = Timeout.InfiniteTimeSpan
    };

    internal async Task<JsonElement> Read(string path, CancellationToken token,
        string? action = null, JsonNode? body = null)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TimeSpan.FromSeconds(26));
        using var request = new HttpRequestMessage(action is null ? HttpMethod.Get : HttpMethod.Post, path);
        if (action is not null)
        {
            request.Headers.Add("Origin", http.BaseAddress!.GetLeftPart(UriPartial.Authority));
            request.Headers.Add("X-Context-Action", action);
            if (body is not null) request.Content = JsonContent.Create(body);
        }
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token).ConfigureAwait(false);
        await using var content = await response.Content.ReadAsStreamAsync(deadline.Token).ConfigureAwait(false);
        var data = await JsonSerializer.DeserializeAsync<JsonElement>(content, cancellationToken: deadline.Token).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode) throw new HttpRequestException(data.Str("error") ?? $"HTTP {(int)response.StatusCode}");
        return data;
    }

    internal async Task Listen(string? id, Action<string[]> events, Action<bool> connection, CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, id is null ? "/api/events" : $"/api/events?id={id}");
                using var handshake = CancellationTokenSource.CreateLinkedTokenSource(token);
                handshake.CancelAfter(TimeSpan.FromSeconds(5));
                using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, handshake.Token).ConfigureAwait(false);
                response.EnsureSuccessStatusCode();
                handshake.CancelAfter(Timeout.InfiniteTimeSpan);
                await using var content = await response.Content.ReadAsStreamAsync(token).ConfigureAwait(false);
                using var reader = new StreamReader(content);
                connection(true);
                while (await reader.ReadLineAsync(token).AsTask().WaitAsync(TimeSpan.FromSeconds(45), token).ConfigureAwait(false) is { } line)
                {
                    if (line.StartsWith("data: ", StringComparison.Ordinal))
                        events(JsonSerializer.Deserialize<string[]>(line.AsSpan(6)) ?? []);
                }
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
            catch (Exception error) when (error is HttpRequestException or IOException or TimeoutException or OperationCanceledException or JsonException) { }
            connection(false);
            try { await Task.Delay(TimeSpan.FromSeconds(2), token).ConfigureAwait(false); }
            catch (OperationCanceledException) { return; }
        }
    }

    internal static string Query(string path, string thread, params (string Name, string? Value)[] fields)
    {
        string query = $"id={Uri.EscapeDataString(thread)}";
        foreach (var (name, value) in fields)
            if (value is not null) query += $"&{name}={Uri.EscapeDataString(value)}";
        return $"/api/{path}?{query}";
    }

    public void Dispose() => http.Dispose();
}

internal static class JsonValues
{
    private static readonly JsonSerializerOptions Pretty = new() { WriteIndented = true };
    internal static JsonElement Get(this JsonElement value, string name) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var item) ? item : default;
    internal static string? Str(this JsonElement value, string name) => value.Get(name).String();
    internal static string? String(this JsonElement value) => value.ValueKind == JsonValueKind.String ? value.GetString() : null;
    internal static double? Num(this JsonElement value, string name) =>
        value.Get(name) is { ValueKind: JsonValueKind.Number } item && item.TryGetDouble(out double number) ? number : null;
    internal static bool Flag(this JsonElement value, string name) => value.Get(name).ValueKind == JsonValueKind.True;
    internal static bool Exists(this JsonElement value) => value.ValueKind is not (JsonValueKind.Null or JsonValueKind.Undefined);
    internal static IEnumerable<JsonElement> Items(this JsonElement value) =>
        value.ValueKind == JsonValueKind.Array ? value.EnumerateArray() : Enumerable.Empty<JsonElement>();
    internal static string FormatJson(this JsonElement value) => value.Exists() ? JsonSerializer.Serialize(value, Pretty) : "";
}
