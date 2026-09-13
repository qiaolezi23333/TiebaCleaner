using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Input;
using System.Windows.Interop;

namespace TiebaCleaner.Bootstrapper;

public partial class MainWindow : Window
{
  private const int DwmwaUseImmersiveDarkMode = 20;
  private const int DwmwaWindowCornerPreference = 33;
  private const int DwmwaBorderColor = 34;
  private readonly InstallerViewModel viewModel;

  internal MainWindow(InstallerViewModel viewModel)
  {
    this.viewModel = viewModel;
    DataContext = viewModel;
    InitializeComponent();
    Loaded += (_, _) => viewModel.StartDetection();
  }

  private void TitleBar_OnMouseLeftButtonDown(object sender, MouseButtonEventArgs e)
  {
    if (e.ClickCount == 2)
      WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
    else
      DragMove();
  }

  private void Minimize_OnClick(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;
  private void Close_OnClick(object sender, RoutedEventArgs e) => Close();

  protected override void OnSourceInitialized(EventArgs e)
  {
    base.OnSourceInitialized(e);
    var handle = new WindowInteropHelper(this).Handle;
    var enabled = 1;
    var rounded = 2;
    var noBorder = unchecked((int)0xFFFFFFFE);
    _ = DwmSetWindowAttribute(handle, DwmwaUseImmersiveDarkMode, ref enabled, sizeof(int));
    _ = DwmSetWindowAttribute(handle, DwmwaWindowCornerPreference, ref rounded, sizeof(int));
    _ = DwmSetWindowAttribute(handle, DwmwaBorderColor, ref noBorder, sizeof(int));
  }

  protected override void OnClosing(CancelEventArgs e)
  {
    if (!viewModel.TryClose()) e.Cancel = true;
    base.OnClosing(e);
  }

  [DllImport("dwmapi.dll")]
  private static extern int DwmSetWindowAttribute(nint window, int attribute, ref int value, int size);
}
