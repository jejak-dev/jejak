namespace Jejak.Shell;

/// <summary>Tahap pembaruan; nilai teks dipakai UI web (kontrak <c>desktop.ts</c>).</summary>
public enum UpdatePhase { Idle, Checking, Available, Downloading, Installing, Ready, Error }

/// <summary>Keadaan pembaruan yang dilihat UI beserta aturan transisinya (sama dengan macOS dan modul Rust).</summary>
public sealed class UpdateStatus
{
    public UpdatePhase State { get; private set; } = UpdatePhase.Idle;
    public string? Version { get; private set; }
    public string? Notes { get; private set; }
    public string? Date { get; private set; }
    public ulong Downloaded { get; private set; }
    public ulong? Total { get; private set; }
    public string? Error { get; private set; }
    public ulong? LastCheck { get; private set; }

    public UpdateStatus Clone() => (UpdateStatus)MemberwiseClone();

    public static string PhaseName(UpdatePhase p) => p.ToString().ToLowerInvariant();

    /// <summary>Bentuk JSON untuk jembatan (<c>updater_status</c>), kunci camelCase.</summary>
    public Dictionary<string, object> ToJson()
    {
        var d = new Dictionary<string, object> { ["state"] = PhaseName(State), ["downloaded"] = Downloaded };
        if (Version != null) d["version"] = Version;
        if (Notes != null) d["notes"] = Notes;
        if (Date != null) d["date"] = Date;
        if (Total != null) d["total"] = Total.Value;
        if (Error != null) d["error"] = Error;
        if (LastCheck != null) d["lastCheck"] = LastCheck.Value;
        return d;
    }

    public bool StartCheck(ulong at)
    {
        if (State is not (UpdatePhase.Idle or UpdatePhase.Error)) return false;
        State = UpdatePhase.Checking;
        Version = Notes = Date = null;
        Downloaded = 0; Total = null; Error = null;
        LastCheck = at;
        return true;
    }

    public bool FinishCheck(ulong at, string? version, string? notes, string? date)
    {
        if (State != UpdatePhase.Checking) return false;
        LastCheck = at; Error = null;
        if (version != null) { State = UpdatePhase.Available; Version = version; Notes = notes; Date = date; }
        else { State = UpdatePhase.Idle; Version = Notes = Date = null; }
        return true;
    }

    public bool StartDownload()
    {
        if (State != UpdatePhase.Available) return false;
        State = UpdatePhase.Downloading; Downloaded = 0; Total = null; Error = null;
        return true;
    }

    public bool Progress(ulong downloaded, ulong? total)
    {
        if (State != UpdatePhase.Downloading) return false;
        Downloaded = downloaded; Total = total;
        return true;
    }

    public bool FinishDownload()
    {
        if (State != UpdatePhase.Downloading) return false;
        State = UpdatePhase.Installing;
        return true;
    }

    public bool FinishInstall()
    {
        if (State != UpdatePhase.Installing) return false;
        State = UpdatePhase.Ready;
        return true;
    }

    public bool Fail(ulong at, string message)
    {
        var before = State;
        State = UpdatePhase.Error;
        Error = message;
        if (before == UpdatePhase.Checking) LastCheck = at;
        return true;
    }

    public bool DropPending()
    {
        if (State != UpdatePhase.Available) return false;
        State = UpdatePhase.Idle; Version = Notes = Date = null;
        return true;
    }
}
