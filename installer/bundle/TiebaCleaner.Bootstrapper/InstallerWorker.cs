using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace TiebaCleaner.Bootstrapper;

internal static class InstallerWorker
{
  private const uint InstallUiLevelNone = 2;
  private const uint InstallStateDefault = 5;
  private const uint InstallStateAbsent = 2;
  private const uint MessageTypeMask = 0xFF000000;
  private const uint InstallMessageFatalExit = 0x00000000;
  private const uint InstallMessageError = 0x01000000;
  private const uint InstallMessageActionStart = 0x08000000;
  private const uint InstallMessageActionData = 0x09000000;
  private const uint InstallMessageProgress = 0x0A000000;
  private const uint LogMode = (1u << 0) | (1u << 1) | (1u << 8) | (1u << 9) | (1u << 10);
  private const int IdOk = 1;
  private const int IdCancel = 2;
  private static readonly object WriteLock = new();
  private static StreamWriter? writer;
  private static CancellationTokenSource? cancellation;
  private static readonly MsiProgressTracker ProgressTracker = new();
  private static ExternalUiRecordHandler? callbackRoot;

  public static int Run(string[] args)
  {
    try
    {
      var pipeName = GetArgument(args, "--pipe");
      var operation = Enum.Parse<InstallerOperation>(GetArgument(args, "--operation"), true);
      var msiPath = GetArgument(args, "--msi");
      var target = GetArgument(args, "--target", false) ?? string.Empty;
      var productCode = GetArgument(args, "--product", false) ?? string.Empty;
      var allUsers = args.Contains("--all-users", StringComparer.OrdinalIgnoreCase);

      using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
      pipe.Connect(120_000);
      using var reader = new StreamReader(pipe, Encoding.UTF8, false, leaveOpen: true);
      writer = new StreamWriter(pipe, new UTF8Encoding(false), leaveOpen: true) { AutoFlush = true };
      cancellation = new CancellationTokenSource();
      _ = ListenForCancellationAsync(reader, cancellation);

      // Keep the verified MSI open without write/delete sharing for the entire
      // elevated operation, closing the verify-to-install substitution window.
      using var packageLock = new FileStream(msiPath, FileMode.Open, FileAccess.Read, FileShare.Read);
      var actualHash = Convert.ToHexString(SHA256.HashData(packageLock));
      if (!actualHash.Equals(PayloadManager.GetExpectedHash(), StringComparison.OrdinalIgnoreCase))
        throw new InvalidDataException("MSI 载荷校验失败，已拒绝执行。");

      if (operation is InstallerOperation.Repair or InstallerOperation.Uninstall)
      {
        var installed = MsiProductLocator.FindNewest();
        if (installed is null || !installed.ProductCode.Equals(productCode, StringComparison.OrdinalIgnoreCase))
          throw new InvalidOperationException("维护目标不属于贴吧清理助手，已拒绝执行。");
      }

      Send(new WorkerMessage("stage", 1, "已再次验证安装文件，正在启动 Windows Installer"));
      callbackRoot = OnInstallerMessage;
      _ = MsiSetExternalUIRecord(callbackRoot, LogMode, IntPtr.Zero, IntPtr.Zero);
      var owner = IntPtr.Zero;
      _ = MsiSetInternalUI(InstallUiLevelNone, ref owner);

      var result = operation switch
      {
        InstallerOperation.Install => MsiInstallProduct(msiPath, BuildInstallProperties(target, allUsers)),
        InstallerOperation.Repair => MsiConfigureProductEx(productCode, 0, InstallStateDefault, "REINSTALL=ALL REINSTALLMODE=vomus REBOOT=ReallySuppress"),
        InstallerOperation.Uninstall => MsiConfigureProductEx(productCode, 0, InstallStateAbsent, "REBOOT=ReallySuppress"),
        _ => 1603u
      };

      var cancelled = result == 1602 || cancellation.IsCancellationRequested;
      Send(new WorkerMessage("result", result is 0 or 1641 or 3010 ? 100 : CurrentProgress(), cancelled ? "操作已取消并回滚" : ResultText(result), unchecked((int)result)));
      return unchecked((int)result);
    }
    catch (Exception error)
    {
      try { Send(new WorkerMessage("result", CurrentProgress(), error.Message, 1603)); } catch { }
      return 1603;
    }
    finally
    {
      writer?.Dispose();
      cancellation?.Dispose();
      writer = null;
      cancellation = null;
      callbackRoot = null;
    }
  }

  private static async Task ListenForCancellationAsync(StreamReader reader, CancellationTokenSource source)
  {
    try
    {
      while (await reader.ReadLineAsync() is { } line)
      {
        if (line.Equals("cancel", StringComparison.OrdinalIgnoreCase))
        {
          source.Cancel();
          break;
        }
      }
    }
    catch { }
  }

  private static int OnInstallerMessage(IntPtr context, uint messageType, IntPtr recordHandle)
  {
    if (cancellation?.IsCancellationRequested == true) return IdCancel;

    switch (messageType & MessageTypeMask)
    {
      case InstallMessageProgress:
        ProcessProgressRecord(recordHandle);
        break;
      case InstallMessageActionStart:
        var description = GetRecordString(recordHandle, 2);
        if (!string.IsNullOrWhiteSpace(description)) Send(new WorkerMessage("stage", CurrentProgress(), description));
        break;
      case InstallMessageActionData:
        if (ProgressTracker.ProcessActionData()) Send(new WorkerMessage("progress", CurrentProgress()));
        break;
      case InstallMessageError:
      case InstallMessageFatalExit:
        var error = GetRecordString(recordHandle, 0);
        if (!string.IsNullOrWhiteSpace(error)) Send(new WorkerMessage("error", CurrentProgress(), error));
        break;
    }

    return IdOk;
  }

  private static void ProcessProgressRecord(IntPtr record)
  {
    if (ProgressTracker.ProcessRecord(
        MsiRecordGetInteger(record, 1),
        MsiRecordGetInteger(record, 2),
        MsiRecordGetInteger(record, 3)))
      Send(new WorkerMessage("progress", CurrentProgress()));
  }

  private static int CurrentProgress() => ProgressTracker.Percentage;

  private static string GetRecordString(IntPtr record, uint field)
  {
    uint length = 0;
    _ = MsiRecordGetString(record, field, null, ref length);
    if (length == 0) return string.Empty;
    length++;
    var buffer = new StringBuilder((int)length);
    return MsiRecordGetString(record, field, buffer, ref length) == 0 ? buffer.ToString() : string.Empty;
  }

  internal static string BuildInstallProperties(string target, bool allUsers)
  {
    if (target.Contains('"')) throw new ArgumentException("安装路径包含不支持的字符。");
    var scope = allUsers ? "ALLUSERS=1" : "ALLUSERS=2 MSIINSTALLPERUSER=1";
    return $"APPLICATIONFOLDER=\"{target}\" {scope} REBOOT=ReallySuppress WIXUI_EXITDIALOGOPTIONALCHECKBOX=0";
  }

  private static string ResultText(uint code) => code switch
  {
    0 => "Windows Installer 已完成全部操作",
    1602 => "用户取消了安装",
    1603 => "Windows Installer 遇到严重错误",
    1618 => "另一个安装任务正在运行，请稍后重试",
    1641 or 3010 => "安装完成，需要重启 Windows",
    _ => $"Windows Installer 返回错误 {code}"
  };

  private static void Send(WorkerMessage message)
  {
    lock (WriteLock)
    {
      writer?.WriteLine(JsonSerializer.Serialize(message));
    }
  }

  private static string GetArgument(string[] args, string name, bool required = true)
  {
    var index = Array.FindIndex(args, item => item.Equals(name, StringComparison.OrdinalIgnoreCase));
    if (index >= 0 && index + 1 < args.Length) return args[index + 1];
    if (!required) return null!;
    throw new ArgumentException($"缺少工作进程参数：{name}");
  }

  [UnmanagedFunctionPointer(CallingConvention.Winapi)]
  private delegate int ExternalUiRecordHandler(IntPtr context, uint messageType, IntPtr recordHandle);

  [DllImport("msi.dll", CharSet = CharSet.Unicode)]
  private static extern uint MsiSetExternalUIRecord(ExternalUiRecordHandler handler, uint messageFilter, IntPtr context, IntPtr previousHandler);

  [DllImport("msi.dll")]
  private static extern uint MsiSetInternalUI(uint uiLevel, ref IntPtr ownerWindow);

  [DllImport("msi.dll", CharSet = CharSet.Unicode)]
  private static extern uint MsiInstallProduct(string packagePath, string commandLine);

  [DllImport("msi.dll", CharSet = CharSet.Unicode)]
  private static extern uint MsiConfigureProductEx(string productCode, int installLevel, uint installState, string commandLine);

  [DllImport("msi.dll")]
  private static extern int MsiRecordGetInteger(IntPtr recordHandle, uint field);

  [DllImport("msi.dll", CharSet = CharSet.Unicode)]
  private static extern uint MsiRecordGetString(IntPtr recordHandle, uint field, StringBuilder? value, ref uint valueLength);
}
