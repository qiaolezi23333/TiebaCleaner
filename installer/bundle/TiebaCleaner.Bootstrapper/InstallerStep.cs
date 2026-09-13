namespace TiebaCleaner.Bootstrapper;

internal enum InstallerStepState
{
  Upcoming,
  Current,
  Completed
}

internal sealed class InstallerStep(int number, string title) : ObservableObject
{
  private InstallerStepState state;

  public int Number { get; } = number;
  public string Title { get; } = title;

  public InstallerStepState State
  {
    get => state;
    private set
    {
      if (!SetProperty(ref state, value)) return;
      Notify(nameof(Marker));
    }
  }

  public string Marker => State == InstallerStepState.Completed ? "✓" : Number.ToString("00");

  public void Update(InstallerStepState value) => State = value;
}
