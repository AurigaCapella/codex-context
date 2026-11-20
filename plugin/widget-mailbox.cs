using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public sealed class WidgetMailbox : IDisposable
{
    private readonly string name;
    private readonly int processId;
    private readonly CancellationTokenSource stop = new CancellationTokenSource();
    private readonly Task listener;
    private readonly Action<string> received;

    public WidgetMailbox(string name, int processId, Action<string> received)
    {
        this.name = name;
        this.processId = processId;
        this.received = received;
        listener = ListenAsync(OpenPipe(), stop.Token);
    }

    private NamedPipeServerStream OpenPipe()
    {
        return new NamedPipeServerStream(name, PipeDirection.InOut, 1,
            PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
    }

    private async Task ListenAsync(NamedPipeServerStream? first, CancellationToken stopped)
    {
        while (!stopped.IsCancellationRequested)
        {
            try
            {
                using (var pipe = first ?? OpenPipe())
                {
                    first = null;
                    await pipe.WaitForConnectionAsync(stopped).ConfigureAwait(false);
                    using (var deadline = CancellationTokenSource.CreateLinkedTokenSource(stopped))
                    {
                        deadline.CancelAfter(1500);
                        await ReceiveAsync(pipe, deadline.Token).ConfigureAwait(false);
                    }
                }
            }
            catch (OperationCanceledException) { }
            catch (IOException)
            {
                if (!stopped.IsCancellationRequested)
                    await Task.Delay(100).ConfigureAwait(false);
            }
        }
    }

    private async Task ReceiveAsync(PipeStream pipe, CancellationToken token)
    {
        var packet = new byte[37];
        for (int offset = 0; offset < packet.Length;)
        {
            int read = await pipe.ReadAsync(packet, offset, packet.Length - offset, token).ConfigureAwait(false);
            if (read == 0) return;
            offset += read;
        }
        char mode = (char)packet[0];
        string threadId = Encoding.ASCII.GetString(packet, 1, 36).TrimEnd();
        Guid id;
        if ((mode != 'O' && mode != 'D') || (threadId.Length > 0 && !Guid.TryParseExact(threadId, "D", out id)))
            return;
        received(mode + threadId);
        var ack = BitConverter.GetBytes(processId);
        await pipe.WriteAsync(ack, 0, ack.Length, token).ConfigureAwait(false);
    }

    public void Dispose()
    {
        stop.Cancel();
        if (listener.IsFaulted) _ = listener.Exception;
        stop.Dispose();
    }
}
