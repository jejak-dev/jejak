namespace Jejak.Shell;

/// <summary>Penyangga baris berkapasitas tetap (stderr sidecar), aman lintas thread.</summary>
public sealed class LineRingBuffer(int capacity = 200)
{
    private readonly Queue<string> _lines = new();
    private readonly object _lock = new();
    private readonly int _capacity = Math.Max(1, capacity);

    public void Append(string line)
    {
        lock (_lock)
        {
            while (_lines.Count >= _capacity) _lines.Dequeue();
            _lines.Enqueue(line);
        }
    }

    public IReadOnlyList<string> Snapshot() { lock (_lock) return _lines.ToArray(); }

    public string Summary(int maxLines = 40) => string.Join("\n", Snapshot().TakeLast(maxLines));
}
