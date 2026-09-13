using System.IO;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;

namespace TiebaCleaner.Bootstrapper;

internal sealed class PayloadManager : IDisposable
{
  private const string ResourceName = "TiebaCleaner.Payload.msi";
  private readonly string directory;

  private PayloadManager(string directory, string msiPath)
  {
    this.directory = directory;
    MsiPath = msiPath;
  }

  public string MsiPath { get; }

  public static async Task<PayloadManager> ExtractAsync(CancellationToken cancellationToken)
  {
    var assembly = Assembly.GetExecutingAssembly();
    await using var resource = assembly.GetManifestResourceStream(ResourceName)
        ?? throw new InvalidOperationException("安装包中没有找到 MSI 载荷，请重新下载安装程序。");

    var directory = Path.Combine(Path.GetTempPath(), "TiebaCleanerSetup", Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(directory);
    RestrictDirectory(directory);

    var msiPath = Path.Combine(directory, "TiebaCleaner.msi");
    await using (var output = new FileStream(msiPath, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1024 * 1024, FileOptions.Asynchronous | FileOptions.WriteThrough))
    {
      await resource.CopyToAsync(output, cancellationToken);
    }

    var expected = GetExpectedHash();

    await using var verifyStream = File.OpenRead(msiPath);
    var actual = Convert.ToHexString(await SHA256.HashDataAsync(verifyStream, cancellationToken));
    if (!actual.Equals(expected, StringComparison.OrdinalIgnoreCase))
    {
      throw new InvalidDataException("MSI 载荷校验失败，安装程序可能已损坏。");
    }

    return new PayloadManager(directory, msiPath);
  }

  internal static string GetExpectedHash()
  {
    var expected = Assembly.GetExecutingAssembly().GetCustomAttributes<AssemblyMetadataAttribute>()
        .FirstOrDefault(item => item.Key == "PayloadSha256")?.Value;
    return string.IsNullOrWhiteSpace(expected)
        ? throw new InvalidOperationException("安装包缺少 MSI 校验值，请重新下载安装程序。")
        : expected;
  }

  public void Dispose()
  {
    for (var attempt = 0; attempt < 5; attempt++)
    {
      try
      {
        if (Directory.Exists(directory)) Directory.Delete(directory, true);
        return;
      }
      catch
      {
        // Temporary cleanup must never turn a successful MSI operation into
        // a reported failure. Antivirus scanners can briefly hold the file.
        if (attempt < 4) Thread.Sleep(100);
      }
    }
  }

  private static void RestrictDirectory(string path)
  {
    var currentUser = WindowsIdentity.GetCurrent().User
        ?? throw new InvalidOperationException("无法识别当前 Windows 用户。");
    var security = new DirectorySecurity();
    security.SetAccessRuleProtection(true, false);
    const InheritanceFlags inheritance = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
    security.AddAccessRule(new FileSystemAccessRule(currentUser, FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
    security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
    security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
    new DirectoryInfo(path).SetAccessControl(security);
  }
}
