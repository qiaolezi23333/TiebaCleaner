namespace TiebaCleaner.Bootstrapper;

internal sealed class MsiProgressTracker
{
  private long totalTicks;
  private long completedTicks;
  private bool forward = true;
  private int ticksPerActionData;

  public int Percentage => totalTicks <= 0
      ? 1
      : Math.Clamp((int)Math.Round(completedTicks * 100d / totalTicks), 0, 100);

  public bool ProcessRecord(int kind, int ticks, int field3)
  {
    switch (kind)
    {
      case 0:
        totalTicks = Math.Max(1, ticks);
        forward = field3 == 0;
        completedTicks = forward ? 0 : totalTicks;
        ticksPerActionData = 0;
        return true;
      case 1:
        ticksPerActionData = field3 == 1 ? Math.Max(0, ticks) : 0;
        return false;
      case 2:
        Advance(ticks);
        return true;
      case 3:
        var addition = Math.Max(0, ticks);
        totalTicks += addition;
        if (!forward) completedTicks += addition;
        return true;
      default:
        return false;
    }
  }

  public bool ProcessActionData()
  {
    if (ticksPerActionData <= 0) return false;
    Advance(ticksPerActionData);
    return true;
  }

  private void Advance(int ticks)
  {
    completedTicks += forward ? ticks : -ticks;
    completedTicks = Math.Clamp(completedTicks, 0, Math.Max(1, totalTicks));
  }
}
