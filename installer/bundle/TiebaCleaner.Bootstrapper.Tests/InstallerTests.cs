using System.IO;
using System.Threading;

namespace TiebaCleaner.Bootstrapper.Tests;

public sealed class InstallerTests
{
  [Fact]
  public void CurrentUserPropertiesKeepMsiPerUser()
  {
    var properties = InstallerWorker.BuildInstallProperties(@"C:\Apps\TiebaCleaner", false);

    Assert.Contains("ALLUSERS=2", properties);
    Assert.Contains("MSIINSTALLPERUSER=1", properties);
    Assert.Contains("APPLICATIONFOLDER=\"C:\\Apps\\TiebaCleaner\"", properties);
  }

  [Fact]
  public void AllUserPropertiesRequestPerMachineWithoutPerUserFlag()
  {
    var properties = InstallerWorker.BuildInstallProperties(@"C:\Program Files\TiebaCleaner", true);

    Assert.Contains("ALLUSERS=1", properties);
    Assert.DoesNotContain("MSIINSTALLPERUSER", properties);
  }

  [Fact]
  public void RequirementsAlwaysExposeFourInlineChecks()
  {
    var snapshot = SystemRequirements.Evaluate(Path.GetTempPath(), false);

    Assert.Equal(4, snapshot.Items.Count);
    Assert.Collection(
        snapshot.Items,
        item => Assert.Equal("Windows 版本", item.Title),
        item => Assert.Equal("系统架构", item.Title),
        item => Assert.Equal("磁盘空间", item.Title),
        item => Assert.Equal("安装权限", item.Title));
  }

  [Fact]
  public void QuoteInTargetPathIsRejectedBeforeCallingMsi()
  {
    Assert.Throws<ArgumentException>(() => InstallerWorker.BuildInstallProperties("C:\\bad\"path", false));
  }

  [Fact]
  public void MsiProgressUsesExplicitProgressRecords()
  {
    var tracker = new MsiProgressTracker();

    tracker.ProcessRecord(0, 1_000, 0);
    tracker.ProcessRecord(2, 250, 0);

    Assert.Equal(25, tracker.Percentage);
  }

  [Fact]
  public void MsiProgressUsesActionDataAndExtendedTotal()
  {
    var tracker = new MsiProgressTracker();

    tracker.ProcessRecord(0, 100, 0);
    tracker.ProcessRecord(3, 100, 0);
    tracker.ProcessRecord(1, 20, 1);
    Assert.True(tracker.ProcessActionData());
    Assert.True(tracker.ProcessActionData());

    Assert.Equal(20, tracker.Percentage);
  }

  [Fact]
  public void ClosingWhileBusyUsesInlineCancellationConfirmation()
  {
    var viewModel = new InstallerViewModel();
    var stage = typeof(InstallerViewModel).GetField("stage", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic);
    stage!.SetValue(viewModel, InstallerStage.Applying);

    Assert.False(viewModel.TryClose());
    Assert.True(viewModel.CancelConfirmationVisible);
  }

  [Fact]
  public void SidebarStepsAdvanceWithInstallerStage()
  {
    var viewModel = new InstallerViewModel();

    Assert.Equal(InstallerStepState.Current, viewModel.Steps[0].State);
    SetStage(viewModel, InstallerStage.Ready);
    Assert.Equal(InstallerStepState.Completed, viewModel.Steps[0].State);
    Assert.Equal(InstallerStepState.Current, viewModel.Steps[1].State);
    SetStage(viewModel, InstallerStage.Applying);
    Assert.Equal(InstallerStepState.Completed, viewModel.Steps[1].State);
    Assert.Equal(InstallerStepState.Current, viewModel.Steps[2].State);
    SetStage(viewModel, InstallerStage.Succeeded);
    Assert.Equal(InstallerStepState.Completed, viewModel.Steps[2].State);
    Assert.Equal(InstallerStepState.Current, viewModel.Steps[3].State);
  }

  [Fact]
  public void FinishButtonReflectsLaunchPreference()
  {
    var viewModel = new InstallerViewModel();
    SetStage(viewModel, InstallerStage.Succeeded);

    Assert.True(viewModel.CanLaunchAfterFinish);
    Assert.Equal("完成并打开", viewModel.FinishButtonText);
    viewModel.LaunchAfterFinish = false;
    Assert.Equal("完成", viewModel.FinishButtonText);
  }

  [Fact]
  public void MainWindowXamlLoadsWithoutBindingErrors()
  {
    Exception? failure = null;
    var thread = new Thread(() =>
    {
      try
      {
        var application = new App();
        application.InitializeComponent();
        var window = new MainWindow(new InstallerViewModel());
        window.Close();
      }
      catch (Exception error)
      {
        failure = error;
      }
    });
    thread.SetApartmentState(ApartmentState.STA);
    thread.Start();
    thread.Join();

    Assert.Null(failure);
  }

  private static void SetStage(InstallerViewModel viewModel, InstallerStage stage)
  {
    var property = typeof(InstallerViewModel).GetProperty(nameof(InstallerViewModel.Stage));
    property!.SetValue(viewModel, stage);
  }
}
