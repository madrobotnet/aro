import { win32 } from "node:path";
import { z } from "zod";

const aclSchema = z.strictObject({
  user: z.string().regex(/^S-\d-(?:\d+-)*\d+$/),
  owner: z.string(),
  attributes: z.number().int(),
  rules: z.array(z.strictObject({
    sid: z.string(), type: z.enum(["Allow", "Deny"]),
    rights: z.number().int(), inherited: z.boolean(),
  })),
});

// Encoded argv avoids PowerShell -Command interpreting path bytes as code.
const script = `& { param([string]$EncodedPath)
  $ErrorActionPreference = 'Stop'
  $OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
  $Path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EncodedPath))
  $Item = Get-Item -LiteralPath $Path -Force
  $Acl = Get-Acl -LiteralPath $Path
  $Sid = [Security.Principal.SecurityIdentifier]
  $Rules = @($Acl.GetAccessRules($true, $true, $Sid) | ForEach-Object {
    @{ sid = $_.IdentityReference.Value; type = $_.AccessControlType.ToString()
       rights = [int]$_.FileSystemRights; inherited = $_.IsInherited }
  })
  @{ user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
     owner = $Acl.GetOwner($Sid).Value; attributes = [int]$Item.Attributes
     rules = $Rules } | ConvertTo-Json -Depth 4 -Compress
}`;

export class WindowsPrivacyError extends Error {
  constructor() {
    super("Windows path must be private and free of reparse points: use a directory under your profile whose ACL allows only your account, SYSTEM and Administrators");
    this.name = "WindowsPrivacyError";
  }
}

/** Conservative SID allowlist, not a general Windows effective-access evaluator. */
export async function windowsPrivatePath(path: string, directory: boolean): Promise<void> {
  try {
    // Resolve the system binary directly; a security check must not depend on PATH lookup.
    const powershell = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const child = Bun.spawn([powershell, "-NoProfile", "-NonInteractive", "-Command",
      script, Buffer.from(path).toString("base64")], {
      stdout: "pipe", stderr: "pipe", stdin: "ignore",
      signal: AbortSignal.timeout(10_000),
    });
    const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text(),
      new Response(child.stderr).text()]);
    if (code !== 0) throw new WindowsPrivacyError();
    const acl = aclSchema.parse(JSON.parse(output));
    const allowed = new Set([acl.user, "S-1-5-18", "S-1-5-32-544"]);
    if (Boolean(acl.attributes & 16) !== directory || (acl.attributes & 1024) !== 0 ||
        ![acl.user, "S-1-5-32-544"].includes(acl.owner) ||
        acl.rules.some(rule => rule.type === "Allow" && !allowed.has(rule.sid))) {
      throw new WindowsPrivacyError();
    }
  } catch (error) {
    if (error instanceof WindowsPrivacyError) throw error;
    throw new WindowsPrivacyError();
  }
}
