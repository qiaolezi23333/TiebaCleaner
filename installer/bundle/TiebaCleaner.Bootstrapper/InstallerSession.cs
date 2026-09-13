using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;

namespace TiebaCleaner.Bootstrapper;

internal sealed class InstallerSession : IAsyncDisposable
{
  private NamedPipeServerStream? pipe;
  private StreamWriter? commandWriter;
  private Process? worker;
  private bool cancelRequested;

  public async Task<InstallerRunResult> RunAsync(
      InstallerOperation operation,
      string target,
      bool allUsers,
      string? productCode,
      Action<WorkerMessage> onMessage,
      CancellationToken cancellationToken)
  {
    using var payload = await PayloadManager.ExtractAsync(cancellationToken);
    var pipeName = $"TiebaCleaner.Setup.{Guid.NewGuid():N}";
    pipe = CreatePipe(pipeName);

    var executable = Environment.ProcessPath ?? throw new InvalidOperationException("无法定位安装程序进程。");
    var startInfo = new ProcessStartInfo(executable)
    {
      UseShellExecute = allUsers,
      WorkingDirectory = Path.GetDirectoryName(executable) ?? Environment.CurrentDirectory,
      WindowStyle = ProcessWindowStyle.Hidden
    };
    if (allUsers) startInfo.Verb = "runas";
    AddArgument(startInfo, "--worker");
    AddArgument(startInfo, "--pipe", pipeName);
    AddArgument(startInfo, "--operation", operation.ToString());
    AddArgument(startInfo, "--msi", payload.MsiPath);
    AddArgument(startInfo, "--target", target);
    if (!string.IsNullOrWhiteSpace(productCode)) AddArgument(startInfo, "--product", productCode);
    if (allUsers) AddArgument(startInfo, "--all-users");

    try
    {
      worker = Process.Start(startInfo) ?? throw new InvalidOperationException("无法启动 Windows Installer 工作进程。");
    }
    catch (Win32Exception error) when (error.NativeErrorCode == 1223)
    {
      return new InstallerRunResult(1602, true, "已取消管理员授权，未对系统进行更改。");
    }

    using var connectTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
    connectTimeout.CancelAfter(TimeSpan.FromMinutes(2));
    await pipe.WaitForConnectionAsync(connectTimeout.Token);
    using var reader = new StreamReader(pipe, Encoding.UTF8, false, leaveOpen: true);
    commandWriter = new StreamWriter(pipe, new UTF8Encoding(false), leaveOpen: true) { AutoFlush = true };
    if (cancelRequested) await SendCancelAsync();

    WorkerMessage? result = null;
    while (await reader.ReadLineAsync(cancellationToken) is { } line)
    {
      var message = JsonSerializer.Deserialize<WorkerMessage>(line);
      if (message is null) continue;
      onMessage(message);
      if (message.Kind == "result")
      {
        result = message;
        break;
      }
    }

    await worker.WaitForExitAsync(CancellationToken.None);
    var exitCode = result?.Code ?? worker.ExitCode;
    return new InstallerRunResult(exitCode, exitCode == 1602, result?.Text ?? $"工作进程意外结束（{exitCode}）。");
  }

  public async Task RequestCancelAsync()
  {
    cancelRequested = true;
    await SendCancelAsync();
  }

  private async Task SendCancelAsync()
  {
    if (commandWriter is null) return;
    try
    {
      await commandWriter.WriteLineAsync("cancel");
      await commandWriter.FlushAsync();
    }
    catch { }
  }

  public async ValueTask DisposeAsync()
  {
    if (worker is { HasExited: false })
    {
      try
      {
        await RequestCancelAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        await worker.WaitForExitAsync(timeout.Token);
      }
      catch
      {
        try { worker.Kill(true); } catch { }
      }
    }
    commandWriter?.Dispose();
    pipe?.Dispose();
    worker?.Dispose();
  }

  private static void AddArgument(ProcessStartInfo info, string name, string? value = null)
  {
    info.ArgumentList.Add(name);
    if (value is not null) info.ArgumentList.Add(value);
  }

  private static NamedPipeServerStream CreatePipe(string pipeName)
  {
    var currentUser = WindowsIdentity.GetCurrent().User
        ?? throw new InvalidOperationException("无法识别当前 Windows 用户。");
    var administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
    var security = new PipeSecurity();
    security.SetAccessRuleProtection(true, false);
    security.AddAccessRule(new PipeAccessRule(currentUser, PipeAccessRights.ReadWrite, AccessControlType.Allow));
    security.AddAccessRule(new PipeAccessRule(administrators, PipeAccessRights.ReadWrite, AccessControlType.Allow));

    return NamedPipeServerStreamAcl.Create(
        pipeName,
        PipeDirection.InOut,
        1,
        PipeTransmissionMode.Byte,
        PipeOptions.Asynchronous,
        4096,
        4096,
        security,
        HandleInheritability.None,
        (PipeAccessRights)0);
  }
}
