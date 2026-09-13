using System.Collections.ObjectModel;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows;
using Microsoft.Win32;

namespace TiebaCleaner.Bootstrapper;

internal enum InstallerStage
{
  Detecting,
  Ready,
  Planning,
  Applying,
  Succeeded,
  Failed
}

internal sealed class InstallerViewModel : ObservableObject
{
  private readonly RelayCommand installCommand;
  private readonly RelayCommand repairCommand;
  private readonly RelayCommand uninstallCommand;
  private readonly RelayCommand cancelCommand;
  private readonly RelayCommand confirmCancelCommand;
  private readonly RelayCommand continueCommand;
  private readonly RelayCommand finishCommand;
  private InstallerSession? activeSession;
  private InstalledProduct? installedProduct;
  private InstallerStage stage = InstallerStage.Detecting;
  private string installDirectory;
  private bool installForAllUsers;
  private bool installed;
  private bool upgradeAvailable;
  private bool cancelRequested;
  private bool cancelConfirmationVisible;
  private int progress;
  private string statusText = "正在检测此电脑…";
  private string errorText = string.Empty;
  private bool requirementsPassed;
  private bool launchAfterFinish = true;
  private InstallerOperation currentOperation = InstallerOperation.Install;

  public InstallerViewModel()
  {
    installDirectory = GetPerUserDirectory();
    Requirements = new ObservableCollection<RequirementResult>();
    Steps = new ObservableCollection<InstallerStep>
    {
      new(1, "环境检测"),
      new(2, "安装选项"),
      new(3, "安装进度"),
      new(4, "完成")
    };
    installCommand = new RelayCommand(() => _ = RunOperationAsync(InstallerOperation.Install), () => CanInstall);
    repairCommand = new RelayCommand(() => _ = RunOperationAsync(InstallerOperation.Repair), () => IsMaintenanceReady);
    uninstallCommand = new RelayCommand(() => _ = RunOperationAsync(InstallerOperation.Uninstall), () => IsMaintenanceReady);
    cancelCommand = new RelayCommand(ShowCancelConfirmation, () => IsBusy && !cancelRequested && !CancelConfirmationVisible);
    confirmCancelCommand = new RelayCommand(() => _ = RequestCancelAsync(), () => IsBusy && !cancelRequested && CancelConfirmationVisible);
    continueCommand = new RelayCommand(HideCancelConfirmation, () => IsBusy && !cancelRequested && CancelConfirmationVisible);
    finishCommand = new RelayCommand(Finish, () => IsResultPage);
    BrowseCommand = new RelayCommand(Browse, () => Stage == InstallerStage.Ready && !Installed);
    CloseCommand = new RelayCommand(CloseWindow, () => !IsBusy);
    UpdateSteps();
    RefreshRequirements();
  }

  public ObservableCollection<RequirementResult> Requirements { get; }
  public ObservableCollection<InstallerStep> Steps { get; }
  public RelayCommand BrowseCommand { get; }
  public RelayCommand CloseCommand { get; }
  public RelayCommand InstallCommand => installCommand;
  public RelayCommand RepairCommand => repairCommand;
  public RelayCommand UninstallCommand => uninstallCommand;
  public RelayCommand CancelCommand => cancelCommand;
  public RelayCommand ConfirmCancelCommand => confirmCancelCommand;
  public RelayCommand ContinueCommand => continueCommand;
  public RelayCommand FinishCommand => finishCommand;
  public int ExitCode { get; private set; }

  public InstallerStage Stage
  {
    get => stage;
    private set
    {
      if (!SetProperty(ref stage, value)) return;
      UpdateSteps();
      NotifyDerivedState();
    }
  }

  public string InstallDirectory
  {
    get => installDirectory;
    set { if (SetProperty(ref installDirectory, value)) RefreshRequirements(); }
  }

  public bool InstallForAllUsers
  {
    get => installForAllUsers;
    set
    {
      if (!SetProperty(ref installForAllUsers, value)) return;
      InstallDirectory = value ? GetPerMachineDirectory() : GetPerUserDirectory();
      Notify(nameof(InstallForCurrentUser));
      RefreshRequirements();
    }
  }

  public bool InstallForCurrentUser
  {
    get => !InstallForAllUsers;
    set { if (value) InstallForAllUsers = false; }
  }

  public bool Installed
  {
    get => installed;
    private set { if (SetProperty(ref installed, value)) NotifyDerivedState(); }
  }

  public int Progress
  {
    get => progress;
    private set { if (SetProperty(ref progress, Math.Clamp(value, 0, 100))) Notify(nameof(ProgressLabel)); }
  }

  public string ProgressLabel => $"{Progress}%";
  public string Version => GetCurrentVersion().ToString(3);
  public string ProductAction => upgradeAvailable ? "升级" : "安装";
  public string StatusText { get => statusText; private set => SetProperty(ref statusText, value); }
  public string ErrorText { get => errorText; private set { SetProperty(ref errorText, value); Notify(nameof(HasError)); Notify(nameof(ResultDetail)); } }
  public bool HasError => !string.IsNullOrWhiteSpace(ErrorText);
  public bool RequirementsPassed { get => requirementsPassed; private set => SetProperty(ref requirementsPassed, value); }
  public bool LaunchAfterFinish
  {
    get => launchAfterFinish;
    set
    {
      if (!SetProperty(ref launchAfterFinish, value)) return;
      Notify(nameof(FinishButtonText));
    }
  }
  public bool IsBusy => Stage is InstallerStage.Planning or InstallerStage.Applying;
  public bool CancelConfirmationVisible
  {
    get => cancelConfirmationVisible;
    private set
    {
      if (!SetProperty(ref cancelConfirmationVisible, value)) return;
      cancelCommand.RaiseCanExecuteChanged();
      confirmCancelCommand.RaiseCanExecuteChanged();
      continueCommand.RaiseCanExecuteChanged();
    }
  }
  public bool IsProgressPage => Stage is InstallerStage.Planning or InstallerStage.Applying;
  public bool IsResultPage => Stage is InstallerStage.Succeeded or InstallerStage.Failed;
  public bool IsSetupPage => Stage is InstallerStage.Detecting or InstallerStage.Ready;
  public bool IsSuccessful => Stage == InstallerStage.Succeeded;
  public bool IsFailed => Stage == InstallerStage.Failed;
  public bool IsMaintenanceReady => Stage == InstallerStage.Ready && Installed;
  public bool CanInstall => Stage == InstallerStage.Ready && !Installed && RequirementsPassed;
  public bool CanLaunchAfterFinish => IsSuccessful && currentOperation != InstallerOperation.Uninstall;
  public string FinishButtonText => CanLaunchAfterFinish && LaunchAfterFinish ? "完成并打开" : "完成";
  public string ResultTitle => IsSuccessful ? "操作已完成" : "操作未完成";
  public string ResultDetail => IsSuccessful
      ? string.IsNullOrWhiteSpace(ErrorText) ? GetSuccessText() : $"{GetSuccessText()} {ErrorText}"
      : ErrorText;

  public async void StartDetection()
  {
    Stage = InstallerStage.Detecting;
    StatusText = "正在识别 Windows 和现有安装…";
    try
    {
      installedProduct = await Task.Run(MsiProductLocator.FindNewest);
      var current = GetCurrentVersion();
      upgradeAvailable = installedProduct is not null && installedProduct.Version < current;
      Installed = installedProduct is not null && !upgradeAvailable;
      if (installedProduct is not null)
      {
        InstallForAllUsers = installedProduct.PerMachine;
        if (!string.IsNullOrWhiteSpace(installedProduct.InstallLocation))
        {
          InstallDirectory = installedProduct.InstallLocation;
        }
      }
      Notify(nameof(ProductAction));
      Stage = InstallerStage.Ready;
      RefreshRequirements();
      if (Installed) StatusText = $"已安装 {installedProduct!.Version.ToString(3)}，可修复或卸载";
      else if (upgradeAvailable) StatusText = $"检测到 {installedProduct!.Version.ToString(3)}，可升级到 {Version}";
    }
    catch (Exception error)
    {
      Fail(1603, $"检测失败：{error.Message}");
    }
  }

  public bool TryClose()
  {
    if (!IsBusy) return true;
    if (!cancelRequested) ShowCancelConfirmation();
    return false;
  }

  private async Task RunOperationAsync(InstallerOperation operation)
  {
    if (IsBusy) return;
    ErrorText = string.Empty;
    cancelRequested = false;
    CancelConfirmationVisible = false;
    currentOperation = operation;
    Progress = 0;
    Stage = InstallerStage.Planning;
    StatusText = "正在提取并校验内置 MSI…";
    activeSession = new InstallerSession();

    try
    {
      var elevate = operation == InstallerOperation.Install ? InstallForAllUsers : installedProduct?.PerMachine == true;
      var result = await activeSession.RunAsync(
          operation,
          InstallDirectory,
          elevate,
          installedProduct?.ProductCode,
          ProcessWorkerMessage,
          CancellationToken.None);
      ExitCode = result.ExitCode;
      if (result.Succeeded)
      {
        Progress = 100;
        Stage = InstallerStage.Succeeded;
        StatusText = "全部步骤已完成";
      }
      else
      {
        Fail(result.ExitCode, result.Error);
      }
    }
    catch (Exception error)
    {
      Fail(1603, error.Message);
    }
    finally
    {
      if (activeSession is not null) await activeSession.DisposeAsync();
      activeSession = null;
    }
  }

  private void ProcessWorkerMessage(WorkerMessage message)
  {
    Application.Current.Dispatcher.Invoke(() =>
    {
      if (message.Kind == "progress")
      {
        Stage = InstallerStage.Applying;
        Progress = Math.Max(Progress, message.Progress);
      }
      else if (message.Kind == "stage")
      {
        Stage = InstallerStage.Applying;
        Progress = Math.Max(Progress, message.Progress);
        StatusText = NormalizeMsiStage(message.Text);
      }
      else if (message.Kind == "error")
      {
        ErrorText = message.Text;
      }
    });
  }

  private async Task RequestCancelAsync()
  {
    if (activeSession is null || cancelRequested) return;
    CancelConfirmationVisible = false;
    cancelRequested = true;
    StatusText = "正在安全停止并回滚…";
    cancelCommand.RaiseCanExecuteChanged();
    await activeSession.RequestCancelAsync();
  }

  private void ShowCancelConfirmation()
  {
    CancelConfirmationVisible = true;
    StatusText = "确认停止后，Windows Installer 会安全回滚尚未完成的更改。";
  }

  private void HideCancelConfirmation()
  {
    CancelConfirmationVisible = false;
    StatusText = "安装正在继续…";
  }

  private void Browse()
  {
    var dialog = new OpenFolderDialog { Title = "选择贴吧清理助手安装位置", InitialDirectory = InstallDirectory, Multiselect = false };
    if (dialog.ShowDialog() == true) InstallDirectory = dialog.FolderName;
  }

  private void CloseWindow() => Application.Current.MainWindow?.Close();

  private void Finish()
  {
    if (CanLaunchAfterFinish && LaunchAfterFinish)
    {
      var executable = Path.Combine(InstallDirectory, "TiebaCleaner.exe");
      try
      {
        if (!File.Exists(executable)) throw new FileNotFoundException("找不到应用程序文件。", executable);
        Process.Start(new ProcessStartInfo(executable) { UseShellExecute = true });
      }
      catch
      {
        ErrorText = "无法自动打开应用，你仍可以从开始菜单启动。";
        return;
      }
    }
    CloseWindow();
  }

  private void RefreshRequirements()
  {
    var snapshot = SystemRequirements.Evaluate(InstallDirectory, InstallForAllUsers);
    Requirements.Clear();
    foreach (var item in snapshot.Items) Requirements.Add(item);
    RequirementsPassed = snapshot.CanInstall;
    if (Stage is InstallerStage.Detecting or InstallerStage.Ready) StatusText = snapshot.Summary;
    installCommand.RaiseCanExecuteChanged();
  }

  private void Fail(int code, string message)
  {
    ExitCode = code;
    ErrorText = message;
    StatusText = cancelRequested ? "操作已取消，已回滚更改" : "安装未完成";
    Stage = InstallerStage.Failed;
  }

  private string GetSuccessText() => currentOperation switch
  {
    InstallerOperation.Uninstall => "贴吧清理助手已从这台电脑移除。",
    InstallerOperation.Repair => "应用文件和快捷方式已修复。",
    _ => "贴吧清理助手已准备就绪，可以开始使用。"
  };

  private void NotifyDerivedState()
  {
    foreach (var property in new[] { nameof(IsBusy), nameof(IsProgressPage), nameof(IsResultPage), nameof(IsSetupPage), nameof(IsSuccessful), nameof(IsFailed), nameof(IsMaintenanceReady), nameof(CanInstall), nameof(CanLaunchAfterFinish), nameof(FinishButtonText), nameof(ResultTitle), nameof(ResultDetail) }) Notify(property);
    installCommand.RaiseCanExecuteChanged();
    repairCommand.RaiseCanExecuteChanged();
    uninstallCommand.RaiseCanExecuteChanged();
    cancelCommand.RaiseCanExecuteChanged();
    confirmCancelCommand.RaiseCanExecuteChanged();
    continueCommand.RaiseCanExecuteChanged();
    finishCommand.RaiseCanExecuteChanged();
    BrowseCommand.RaiseCanExecuteChanged();
    CloseCommand.RaiseCanExecuteChanged();
  }

  private void UpdateSteps()
  {
    if (Steps.Count == 0) return;
    var current = Stage switch
    {
      InstallerStage.Detecting => 1,
      InstallerStage.Ready => 2,
      InstallerStage.Planning or InstallerStage.Applying => 3,
      InstallerStage.Succeeded or InstallerStage.Failed => 4,
      _ => 1
    };

    foreach (var step in Steps)
    {
      step.Update(step.Number < current
          ? InstallerStepState.Completed
          : step.Number == current ? InstallerStepState.Current : InstallerStepState.Upcoming);
    }
  }

  private static string NormalizeMsiStage(string text)
  {
    if (text.Contains("InstallFiles", StringComparison.OrdinalIgnoreCase)) return "正在写入应用文件…";
    if (text.Contains("shortcut", StringComparison.OrdinalIgnoreCase)) return "正在创建快捷方式…";
    if (text.Contains("Remove", StringComparison.OrdinalIgnoreCase)) return "正在移除旧文件…";
    if (text.Contains("registry", StringComparison.OrdinalIgnoreCase)) return "正在更新系统注册信息…";
    return string.IsNullOrWhiteSpace(text) ? "Windows Installer 正在处理…" : text;
  }

  private static Version GetCurrentVersion() => Assembly.GetExecutingAssembly().GetName().Version ?? new Version(1, 0, 0);
  private static string GetPerUserDirectory() => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "TiebaCleaner");
  private static string GetPerMachineDirectory() => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "TiebaCleaner");
}
