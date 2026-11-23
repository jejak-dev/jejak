using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Jejak.Shell;

/// <summary>
/// Job object Windows dengan KILL_ON_JOB_CLOSE: bila cangkang mati mendadak,
/// sidecar beserta anak-anaknya ikut mati (tak ada server yatim). No-op di OS lain.
/// </summary>
public sealed class JobObject : IDisposable
{
    private nint _handle;

    public static JobObject? TryCreate()
    {
        if (!OperatingSystem.IsWindows()) return null;
        var job = CreateJobObjectW(0, null);
        if (job == 0) return null;
        var info = new ExtendedLimitInformation();
        info.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        var size = Marshal.SizeOf<ExtendedLimitInformation>();
        var ptr = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(info, ptr, false);
            if (!SetInformationJobObject(job, 9, ptr, (uint)size)) { CloseHandle(job); return null; }
        }
        finally { Marshal.FreeHGlobal(ptr); }
        return new JobObject { _handle = job };
    }

    public bool Assign(Process process)
    {
        if (_handle == 0) return false;
        try { return AssignProcessToJobObject(_handle, process.Handle); }
        catch (InvalidOperationException) { return false; } // proses sudah selesai
    }

    public void Dispose()
    {
        if (_handle != 0) { CloseHandle(_handle); _handle = 0; }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public nuint MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public nuint Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount,
            ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation Basic;
        public IoCounters Io;
        public nuint ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern nint CreateJobObjectW(nint attributes, string? name);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(nint job, int infoClass, nint info, uint length);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(nint job, nint process);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(nint handle);
}
