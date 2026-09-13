using System.Text;
using System.Text.Json.Serialization;

namespace TiebaCleaner.Bootstrapper;

internal enum InstallerOperation
{
  Install,
  Repair,
  Uninstall
}

internal sealed record WorkerMessage(
    [property: JsonPropertyName("kind")] string Kind,
    [property: JsonPropertyName("progress")] int Progress = 0,
    [property: JsonPropertyName("text")] string Text = "",
    [property: JsonPropertyName("code")] int Code = 0);

internal sealed record InstallerRunResult(int ExitCode, bool Cancelled, string Error)
{
  public bool Succeeded => ExitCode is 0 or 1641 or 3010;
}

internal sealed record InstalledProduct(string ProductCode, Version Version, bool PerMachine, string InstallLocation);

internal static class MsiProductLocator
{
  private const string UpgradeCode = "{09495EC9-C590-45A7-8669-1DC5E1709553}";
  private const uint NoMoreItems = 259;

  public static InstalledProduct? FindNewest()
  {
    var results = new List<InstalledProduct>();
    for (uint index = 0; ; index++)
    {
      var code = new StringBuilder(39);
      var status = MsiEnumRelatedProducts(UpgradeCode, 0, index, code);
      if (status == NoMoreItems) break;
      if (status != 0) continue;

      var versionText = GetProductInfo(code.ToString(), "VersionString");
      var assignment = GetProductInfo(code.ToString(), "AssignmentType");
      var installLocation = GetProductInfo(code.ToString(), "InstallLocation");
      if (Version.TryParse(versionText, out var version))
      {
        results.Add(new InstalledProduct(code.ToString(), version, assignment == "1", installLocation));
      }
    }
    return results.OrderByDescending(item => item.Version).FirstOrDefault();
  }

  private static string GetProductInfo(string productCode, string property)
  {
    uint length = 0;
    _ = MsiGetProductInfo(productCode, property, null, ref length);
    length++;
    var value = new StringBuilder((int)length);
    return MsiGetProductInfo(productCode, property, value, ref length) == 0 ? value.ToString() : string.Empty;
  }

  [System.Runtime.InteropServices.DllImport("msi.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
  private static extern uint MsiEnumRelatedProducts(string upgradeCode, uint reserved, uint index, StringBuilder productCode);

  [System.Runtime.InteropServices.DllImport("msi.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
  private static extern uint MsiGetProductInfo(string productCode, string property, StringBuilder? value, ref uint valueLength);
}
