using System.IO;

namespace TiebaCleaner.Bootstrapper;

internal static class Program
{
  [STAThread]
  private static int Main(string[] args)
  {
    if (args.Contains("--self-test", StringComparer.OrdinalIgnoreCase))
    {
      return RunSelfTest();
    }

    if (args.Contains("--worker", StringComparer.OrdinalIgnoreCase))
    {
      return InstallerWorker.Run(args);
    }

    var application = new App();
    application.InitializeComponent();
    return application.Run(new MainWindow(new InstallerViewModel()));
  }

  private static int RunSelfTest()
  {
    try
    {
      using var payload = PayloadManager.ExtractAsync(CancellationToken.None).GetAwaiter().GetResult();
      var requirements = SystemRequirements.Evaluate(
          Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "TiebaCleaner"),
          false);
      return File.Exists(payload.MsiPath) && requirements.Items.Count == 4 ? 0 : 1;
    }
    catch
    {
      return 1;
    }
  }
}
