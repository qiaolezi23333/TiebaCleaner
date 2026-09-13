using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32;

namespace TiebaCleaner.Bootstrapper;

internal enum RequirementLevel
{
  Passed,
  Notice,
  Failed
}

internal sealed record RequirementResult(
    string Title,
    string Detail,
    RequirementLevel Level,
    string Glyph);

internal sealed record RequirementSnapshot(
    IReadOnlyList<RequirementResult> Items,
    bool CanInstall,
    string Summary,
    long AvailableBytes);

internal static class SystemRequirements
{
  internal const long MinimumFreeBytes = 650L * 1024 * 1024;

  public static RequirementSnapshot Evaluate(string installDirectory, bool allUsers)
  {
    var buildNumber = ReadWindowsBuildNumber();
    var windowsOk = OperatingSystem.IsWindows() && buildNumber >= 10240;
    var architectureOk = Environment.Is64BitOperatingSystem && RuntimeInformation.OSArchitecture == Architecture.X64;
    var pathOk = Path.IsPathFullyQualified(installDirectory);
    var availableBytes = GetAvailableBytes(installDirectory);
    var diskOk = pathOk && availableBytes >= MinimumFreeBytes;
    var elevated = IsAdministrator();
    var currentUserCanWrite = allUsers || CanWriteToTarget(installDirectory);

    var items = new List<RequirementResult>
        {
            new(
                "Windows 版本",
                windowsOk ? $"{GetWindowsName(buildNumber)} · Build {buildNumber}" : "需要 Windows 10 Build 10240 或更高版本",
                windowsOk ? RequirementLevel.Passed : RequirementLevel.Failed,
                windowsOk ? "✓" : "!"),
            new(
                "系统架构",
                architectureOk ? "64 位 x64 系统" : $"当前架构：{RuntimeInformation.OSArchitecture}，仅支持 x64",
                architectureOk ? RequirementLevel.Passed : RequirementLevel.Failed,
                architectureOk ? "✓" : "!"),
            new(
                "磁盘空间",
                pathOk ? $"可用 {FormatBytes(availableBytes)} · 至少需要 {FormatBytes(MinimumFreeBytes)}" : "请输入带盘符的完整安装路径",
                diskOk ? RequirementLevel.Passed : RequirementLevel.Failed,
                diskOk ? "✓" : "!"),
            new(
                "安装权限",
                allUsers
                    ? elevated ? "已具备管理员权限" : "安装时将请求管理员授权"
                    : currentUserCanWrite ? "当前用户可以写入所选位置，无需管理员权限" : "当前用户无法写入所选位置",
                allUsers && !elevated ? RequirementLevel.Notice : currentUserCanWrite ? RequirementLevel.Passed : RequirementLevel.Failed,
                allUsers && !elevated ? "i" : currentUserCanWrite ? "✓" : "!")
        };

    var canInstall = windowsOk && architectureOk && diskOk && currentUserCanWrite;
    return new RequirementSnapshot(
        items,
        canInstall,
        canInstall ? "检测完成，可以开始安装" : "检测未通过，请处理标红项目后重试",
        availableBytes);
  }

  private static int ReadWindowsBuildNumber()
  {
    try
    {
      using var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
      return int.TryParse(key?.GetValue("CurrentBuildNumber")?.ToString(), out var build) ? build : 0;
    }
    catch
    {
      return 0;
    }
  }

  private static long GetAvailableBytes(string installDirectory)
  {
    try
    {
      var root = Path.GetPathRoot(Path.GetFullPath(installDirectory));
      return string.IsNullOrWhiteSpace(root) ? 0 : new DriveInfo(root).AvailableFreeSpace;
    }
    catch
    {
      return 0;
    }
  }

  private static bool IsAdministrator()
  {
    try
    {
      using var identity = WindowsIdentity.GetCurrent();
      return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
    }
    catch
    {
      return false;
    }
  }

  private static bool CanWriteToTarget(string path)
  {
    try
    {
      var cursor = new DirectoryInfo(Path.GetFullPath(path));
      while (!cursor.Exists && cursor.Parent is not null) cursor = cursor.Parent;
      var probePath = Path.Combine(cursor.FullName, $".tieba-setup-{Guid.NewGuid():N}.tmp");
      using var probe = new FileStream(probePath, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1, FileOptions.DeleteOnClose);
      return true;
    }
    catch
    {
      return false;
    }
  }

  private static string GetWindowsName(int build) => build >= 22000 ? "Windows 11" : "Windows 10";

  private static string FormatBytes(long bytes)
  {
    if (bytes >= 1024L * 1024 * 1024) return $"{bytes / (1024d * 1024 * 1024):0.#} GB";
    return $"{bytes / (1024d * 1024):0} MB";
  }
}
