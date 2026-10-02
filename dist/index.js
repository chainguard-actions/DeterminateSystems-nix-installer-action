// src/index.ts
import * as actionsCore from "@actions/core";
import * as actionsExec from "@actions/exec";
import * as github from "@actions/github";
import { access, readFile, stat, writeFile } from "fs/promises";
import { join } from "path";
import fs, { mkdirSync, openSync } from "fs";
import { userInfo } from "os";
import stringArgv from "string-argv";
import * as path from "path";
import {
  DetSysAction,
  inputs,
  log as log2,
  platform,
  recordSpanError,
  stringifyError,
  withSpan
} from "@determinate-systems/detsys-ts";
import { setTimeout } from "timers/promises";

// src/fixHashes.ts
import { getExecOutput } from "@actions/exec";
async function getFixHashes(since) {
  const output = await getExecOutput(
    "determinate-nixd",
    ["fix", "hashes", "--json", "--since", since],
    { silent: true }
  );
  if (output.exitCode !== 0) {
    throw new Error(
      `determinate-nixd fix hashes returned non-zero exit code ${output.exitCode} with the following error output:
${output.stderr}`
    );
  }
  return JSON.parse(output.stdout);
}

// src/annotate.ts
import { log } from "@determinate-systems/detsys-ts";
function prettyDerivation(derivation) {
  return derivation.replace(/\/nix\/store\/\w+-/, "").replace(/.drv$/, "");
}
function annotateSingle(file, line, { derivation, replacement }) {
  const pretty = prettyDerivation(derivation);
  log.error(`To correct the hash mismatch for ${pretty}, use ${replacement}`, {
    file,
    startLine: line
  });
}
function annotateMultiple(file, { line, found, mismatches }) {
  const matches = mismatches.map(({ derivation, replacement }) => {
    const pretty = prettyDerivation(derivation);
    return `* For the derivation ${pretty}, use ${replacement}`;
  }).join("\n");
  log.error(
    `There are multiple replacements for the expression ${found}:
${matches}`,
    {
      file,
      startLine: line
    }
  );
}
function annotate(file, fix) {
  if (fix.mismatches.length === 1) {
    annotateSingle(file, fix.line, fix.mismatches[0]);
  } else {
    annotateMultiple(file, fix);
  }
}
function annotateMismatches(output) {
  let count = 0;
  for (const { file, fixes } of output.files) {
    for (const fix of fixes) {
      annotate(file, fix);
      count++;
    }
  }
  return count;
}

// src/events.ts
import got from "got";
function parseEvents(data) {
  let hasMismatches = false;
  if (!Array.isArray(data)) {
    return { events: [], hasMismatches };
  }
  const events = data.flatMap((event) => {
    if (event.v === "1" && event.c === "HashMismatchResponseEventV1") {
      hasMismatches = true;
      return [];
    }
    if (event.v === "1" && (event.c === "BuildFailureResponseEventV1" || event.c === "BuiltPathResponseEventV1") && Object.hasOwn(event, "drv") && typeof event.drv === "string" && Object.hasOwn(event, "timing") && typeof event.timing === "object" && event.timing !== null) {
      const timing = event.timing;
      if (Object.hasOwn(timing, "startTime") && typeof timing.startTime === "string" && Object.hasOwn(timing, "durationSeconds") && typeof timing.durationSeconds === "number") {
        const date = Date.parse(timing.startTime);
        if (!Number.isNaN(date)) {
          return [
            {
              v: event.v,
              c: event.c,
              drv: event.drv,
              timing: {
                startTime: new Date(date),
                durationSeconds: timing.durationSeconds
              }
            }
          ];
        }
      }
    }
    return [];
  });
  return { events, hasMismatches };
}
var DAEMON_SOCKET = "/nix/var/determinate/determinate-nixd.socket";
async function getRecentEvents(since) {
  const queryParam = encodeURIComponent(since.toISOString());
  try {
    const resp = await got.get(`http://unix:${DAEMON_SOCKET}:/events/recent?since=${queryParam}`, {
      enableUnixSockets: true
    }).json();
    return parseEvents(resp);
  } catch (error) {
    if (isSocketAbsent(error)) {
      return void 0;
    }
    throw error;
  }
}
function isSocketAbsent(error) {
  let candidate = error;
  for (let link = 0; link < 4 && candidate != null; link++) {
    if (candidate.code === "ENOENT") {
      return true;
    }
    candidate = candidate.cause;
  }
  return false;
}

// src/util.ts
function truncateDerivation(drv) {
  return drv.replace(/^\/nix\/store\/[a-z0-9]+-/, "").replace(/\.drv$/, "");
}

// src/mermaid.ts
function makeMermaidReport(events) {
  const maxLength = 49900;
  let mermaid = "";
  let pruneLevel = -2;
  do {
    pruneLevel += 1;
    mermaid = mermaidify(events, pruneLevel) ?? "";
  } while (mermaid.length > maxLength);
  if (!mermaid) {
    return void 0;
  }
  const lines = [
    "<details open><summary><strong>Build timeline</strong> :hourglass_flowing_sand:</summary>",
    "",
    // load bearing whitespace, deleting it breaks the details expander / markdown
    mermaid,
    ""
    // load bearing whitespace, deleting it breaks the details expander / markdown
  ];
  if (pruneLevel === 0) {
    lines.push("> [!NOTE]");
    lines.push(
      "> `/nix/store/[hash]` and the `.drv` suffixes have been removed to make the graph small enough to render."
    );
  } else if (pruneLevel > 0) {
    lines.push("> [!NOTE]");
    lines.push(
      `> \`/nix/store/[hash]\`, the \`.drv\` suffix, and builds that took less than ${formatDuration(pruneLevel)} have been removed to make the graph small enough to render.`
    );
  }
  lines.push("");
  lines.push("</details>");
  return lines.join("\n");
}
function mermaidify(allEvents, pruneLevel) {
  const events = allEvents.filter(
    (event) => event.c === "BuiltPathResponseEventV1" || event.c === "BuildFailureResponseEventV1"
  ).sort(
    (a, b) => a.timing.startTime.getTime() - b.timing.startTime.getTime()
  );
  const firstEvent = events.at(0);
  if (firstEvent === void 0) {
    return void 0;
  }
  const zeroMoment = firstEvent.timing.startTime.getTime();
  const lines = [
    "```mermaid",
    "gantt",
    "    dateFormat X",
    "    axisFormat %Mm%Ss"
  ];
  for (const event of events) {
    const duration = event.timing.durationSeconds;
    if (duration < pruneLevel) {
      continue;
    }
    const label = pruneLevel >= 0 ? truncateDerivation(event.drv) : event.drv;
    const tag = event.c === "BuildFailureResponseEventV1" ? "crit" : "d";
    const relativeStartTime = (event.timing.startTime.getTime() - zeroMoment) / 1e3;
    lines.push(
      `${label} (${formatDuration(duration)}):${tag}, ${relativeStartTime}, ${duration}s`
    );
  }
  lines.push("```");
  return lines.join("\n");
}
function formatDuration(duration) {
  const durSeconds = duration % 60;
  const durMinutes = (duration - durSeconds) / 60;
  return `${durMinutes > 0 ? `${durMinutes}m` : ""}${durSeconds}s`;
}

// src/failuresummary.ts
import { getExecOutput as getExecOutput2 } from "@actions/exec";
import { stripVTControlCharacters } from "util";
var defaultMaxSummaryLength = 995e3;
function getBuildFailures(events) {
  return events.filter((event) => {
    return event.c === "BuildFailureResponseEventV1";
  });
}
async function summarizeFailures(events, getLog = getLogFromNix, maxLength = defaultMaxSummaryLength) {
  const failures = getBuildFailures(events);
  if (failures.length === 0) {
    return void 0;
  }
  const logLines = [];
  const markdownLines = [];
  logLines.push(
    `\x1B[38;2;255;0;0mBuild logs from ${failures.length} failure${failures.length === 1 ? "" : "s"}`
  );
  logLines.push(
    `The following build logs are also available in the Markdown summary:`
  );
  markdownLines.push(`### Build error review :boom:`);
  markdownLines.push("> [!NOTE]");
  markdownLines.push(
    `> ${failures.length} build${failures.length === 1 ? "" : "s"} failed`
  );
  const markdownLogChunks = [];
  for (const event of failures) {
    const markdownLogChunk = [];
    const txtLogChunk = [];
    txtLogChunk.push(`::group::Failed build: ${event.drv}`);
    const log3 = await getLog(event.drv) ?? "(failure reading the log for this derivation.)";
    const indented = log3.split("\n").map((line) => `    ${line}`);
    markdownLogChunk.push(
      `<details><summary>Failure log: <code>${event.drv.replace(/^(\/nix[^-]*-)(.*)(\.drv)$/, "$1<strong>$2</strong>$3")}</code></summary>`
    );
    markdownLogChunk.push("");
    for (const line of indented) {
      txtLogChunk.push(line);
      markdownLogChunk.push(stripVTControlCharacters(line));
    }
    markdownLogChunk.push("");
    markdownLogChunk.push("</details>");
    markdownLogChunk.push("");
    markdownLogChunks.push({
      drv: event.drv,
      mdLines: markdownLogChunk,
      txtLines: txtLogChunk
    });
    txtLogChunk.push(`::endgroup::`);
  }
  const skippedChunks = [];
  let markdownLength = markdownLines.join("\n").length;
  for (const chunk of markdownLogChunks) {
    const chunkLength = chunk.mdLines.join("\n").length;
    if (markdownLength + chunkLength > maxLength) {
      skippedChunks.push(chunk);
    } else {
      logLines.push(...chunk.txtLines);
      markdownLines.push(...chunk.mdLines);
      markdownLength += chunkLength;
    }
  }
  if (skippedChunks.length > 0) {
    markdownLines.push(
      "",
      "> [!NOTE]",
      `> The following ${skippedChunks.length === 1 ? "failure has" : "failures have"} been omitted due to GitHub Actions' summary length limitations.`,
      "> The full logs are available in the post-run phase of the Nix Installer Action."
    );
    logLines.push(
      "The following build logs are NOT available in the Markdown summary:"
    );
    for (const chunk of skippedChunks) {
      markdownLines.push(`> * \`${chunk.drv}\``);
      logLines.push(...chunk.txtLines);
    }
  }
  return { logLines, markdownLines };
}
async function getLogFromNix(drv) {
  const output = await getExecOutput2("nix", ["log", drv], {
    silent: true
  });
  return output.stdout;
}

// src/index.ts
import { spawn } from "child_process";
var FEAT_ANNOTATIONS = "hash-mismatch-annotations";
var ATTR_DETERMINATE_NIX = "detsys.nix_installer.determinate_nix";
var ATTR_HAS_SYSTEMD = "detsys.nix_installer.has_systemd";
var ATTR_IN_ACT = "detsys.nix_installer.in_act";
var ATTR_IN_NAMESPACE_SO = "detsys.nix_installer.in_namespace_so";
var ATTR_NIX_INSTALLER_PLANNER = "detsys.nix_installer.planner";
var ATTR_SENT_SIGTERM = "detsys.nix_installer.sent_sigterm";
var ATTR_EXIT_CODE = "detsys.exit_code";
var ATTR_JOB_CONCLUSION = "detsys.nix_installer.job_conclusion";
var ATTR_LOGIN_SKIPPED_REASON = "detsys.flakehub.login_skipped_reason";
var ATTR_LOGIN_SUCCEEDED = "detsys.flakehub.login_succeeded";
var ATTR_FOD_MISMATCH_COUNT = "detsys.nix_installer.fod_mismatch_count";
var ATTR_SUMMARY_AVAILABLE = "detsys.nix_installer.summary_available";
var ATTR_BUILDS_SUCCEEDED = "detsys.nix_installer.builds_succeeded";
var ATTR_BUILDS_FAILED = "detsys.nix_installer.builds_failed";
var ATTR_BUILDS_UNKNOWN_EVENT = "detsys.nix_installer.builds_unknown_event";
var ATTR_IS_ROOT = "detsys.nix_installer.is_root";
var ATTR_KVM_ENABLED = "detsys.nix_installer.kvm_enabled";
var ATTR_DAEMON_PID = "detsys.nix_installer.daemon_pid";
var FLAG_DETERMINATE = "--determinate";
var FLAG_PREFER_UPSTREAM_NIX = "--prefer-upstream-nix";
var STATE_DAEMONDIR = "DNI_DAEMONDIR";
var STATE_START_DATETIME = "DETERMINATE_NIXD_START_DATETIME";
var NixInstallerAction = class extends DetSysAction {
  daemonDir;
  determinate;
  platform;
  nixPackageUrl;
  backtrace;
  extraArgs;
  extraConf;
  kvm;
  githubServerUrl;
  githubToken;
  forceNoSystemd;
  init;
  jobConclusion;
  localRoot;
  logDirectives;
  logger;
  sslCertFile;
  proxy;
  macCaseSensitive;
  macEncrypt;
  macRootDisk;
  macVolumeLabel;
  modifyProfile;
  nixBuildGroupId;
  nixBuildGroupName;
  nixBuildUserBase;
  nixBuildUserCount;
  nixBuildUserPrefix;
  planner;
  reinstall;
  startDaemon;
  trustRunnerUser;
  runnerOs;
  summarize;
  constructor() {
    if (platform.getArchOs() === "X64-macOS") {
      log2.error(
        "Determinate Nix Installer no longer supports macOS on Intel. Please migrate to Apple Silicon, and use Nix's built-in Rosetta support to build for Intel. See: https://github.com/DeterminateSystems/nix-src/issues/224"
      );
      const sourceTag = inputs.getStringOrUndefined("source-tag");
      if (sourceTag === void 0) {
        log2.notice(
          "Pinning the installer tag to v3.12.2 (the last version to support Intel Macs) as a temporary fallback."
        );
        process.env["INPUT_SOURCE-TAG"] = "v3.12.2";
      }
    }
    super({
      name: "nix-installer",
      fetchStyle: "nix-style",
      legacySourcePrefix: "nix-installer",
      requireNix: "ignore",
      diagnosticsSuffix: "diagnostic"
    });
    if (actionsCore.getState(STATE_DAEMONDIR) !== "") {
      this.daemonDir = actionsCore.getState(STATE_DAEMONDIR);
    } else {
      this.daemonDir = this.getTemporaryName();
      mkdirSync(this.daemonDir);
      actionsCore.saveState(STATE_DAEMONDIR, this.daemonDir);
    }
    this.determinate = inputs.getBool("determinate") || inputs.getBool("flakehub");
    this.platform = platform.getNixPlatform(platform.getArchOs());
    this.nixPackageUrl = inputs.getStringOrNull("nix-package-url");
    this.backtrace = inputs.getStringOrNull("backtrace");
    this.extraArgs = inputs.getStringOrNull("extra-args");
    this.extraConf = inputs.getMultilineStringOrNull("extra-conf");
    this.kvm = inputs.getBool("kvm");
    this.forceNoSystemd = inputs.getBool("force-no-systemd");
    this.githubToken = inputs.getStringOrNull("github-token");
    this.githubServerUrl = inputs.getStringOrNull("github-server-url");
    this.init = inputs.getStringOrNull("init");
    this.jobConclusion = inputs.getStringOrNull("job-status");
    this.localRoot = inputs.getStringOrNull("local-root");
    this.logDirectives = inputs.getStringOrNull("log-directives");
    this.logger = inputs.getStringOrNull("logger");
    this.sslCertFile = inputs.getStringOrNull("ssl-cert-file");
    this.proxy = inputs.getStringOrNull("proxy");
    this.macCaseSensitive = inputs.getStringOrNull("mac-case-sensitive");
    this.macEncrypt = inputs.getStringOrNull("mac-encrypt");
    this.macRootDisk = inputs.getStringOrNull("mac-root-disk");
    this.macVolumeLabel = inputs.getStringOrNull("mac-volume-label");
    this.modifyProfile = inputs.getBool("modify-profile");
    this.nixBuildGroupId = inputs.getNumberOrNull("nix-build-group-id");
    this.nixBuildGroupName = inputs.getStringOrNull("nix-build-group-name");
    this.nixBuildUserBase = inputs.getNumberOrNull("nix-build-user-base");
    this.nixBuildUserCount = inputs.getNumberOrNull("nix-build-user-count");
    this.nixBuildUserPrefix = inputs.getStringOrNull("nix-build-user-prefix");
    this.planner = inputs.getStringOrNull("planner");
    this.reinstall = inputs.getBool("reinstall");
    this.startDaemon = inputs.getBool("start-daemon");
    this.trustRunnerUser = inputs.getBool("trust-runner-user");
    this.summarize = inputs.getBool("summarize");
    this.runnerOs = process.env["RUNNER_OS"];
  }
  async main() {
    actionsCore.saveState(STATE_START_DATETIME, (/* @__PURE__ */ new Date()).toISOString());
    await this.detectAndForceNoSystemd();
    await this.install();
  }
  async post() {
    await this.annotateMismatches();
    if (this.summarize) {
      try {
        await this.summarizeExecution();
      } catch (err) {
        log2.debug(`Could not summarize the execution: ${stringifyError(err)}`);
      }
    }
    await this.cleanupNoSystemd();
    await this.reportOverall();
  }
  get isMacOS() {
    return this.runnerOs === "macOS";
  }
  get isLinux() {
    return this.runnerOs === "Linux";
  }
  get isRunningInAct() {
    return process.env["ACT"] !== void 0 && !(process.env["NOT_ACT"] === "");
  }
  get isRunningInNamespaceRunner() {
    return process.env["NSC_VM_ID"] !== void 0 && !(process.env["NOT_NAMESPACE"] === "true");
  }
  // Detect if we're in a GHA runner which is Linux and doesn't have Systemd.
  // This is a common case in self-hosted runners, providers like [Namespace](https://namespace.so/),
  // and especially GitHub Enterprise Server.
  async detectAndForceNoSystemd() {
    return log2.group("detect_systemd", "Detecting systemd...", async () => {
      if (!this.isLinux) {
        if (this.forceNoSystemd) {
          this.forceNoSystemd = false;
          log2.warning(
            "Ignoring force-no-systemd which is set to true, as it is only supported on Linux."
          );
        }
        return;
      }
      const systemdCheck = fs.statSync("/run/systemd/system", {
        throwIfNoEntry: false
      });
      if (systemdCheck?.isDirectory()) {
        this.setAttribute(ATTR_HAS_SYSTEMD, true);
      } else {
        this.setAttribute(ATTR_HAS_SYSTEMD, false);
        this.forceNoSystemd = true;
        this.init = "none";
        this.planner = "linux";
      }
    });
  }
  async executionEnvironment() {
    const executionEnv = {};
    executionEnv.NIX_INSTALLER_NO_CONFIRM = "true";
    executionEnv.NIX_INSTALLER_DIAGNOSTIC_ATTRIBUTION = JSON.stringify(
      this.getCorrelationHashes()
    );
    if (this.backtrace !== null) {
      executionEnv.RUST_BACKTRACE = this.backtrace;
    }
    if (this.modifyProfile !== null) {
      if (this.modifyProfile) {
        executionEnv.NIX_INSTALLER_MODIFY_PROFILE = "true";
      } else {
        executionEnv.NIX_INSTALLER_MODIFY_PROFILE = "false";
      }
    }
    if (this.nixBuildGroupId !== null) {
      executionEnv.NIX_INSTALLER_NIX_BUILD_GROUP_ID = `${this.nixBuildGroupId}`;
    }
    if (this.nixBuildGroupName !== null) {
      executionEnv.NIX_INSTALLER_NIX_BUILD_GROUP_NAME = this.nixBuildGroupName;
    }
    if (this.nixBuildUserPrefix !== null) {
      executionEnv.NIX_INSTALLER_NIX_BUILD_USER_PREFIX = this.nixBuildUserPrefix;
    }
    if (this.nixBuildUserCount !== null) {
      executionEnv.NIX_INSTALLER_NIX_BUILD_USER_COUNT = `${this.nixBuildUserCount}`;
    }
    if (this.nixBuildUserBase !== null) {
      executionEnv.NIX_INSTALLER_NIX_BUILD_USER_ID_BASE = `${this.nixBuildUserBase}`;
    }
    if (this.nixPackageUrl !== null) {
      executionEnv.NIX_INSTALLER_NIX_PACKAGE_URL = `${this.nixPackageUrl}`;
    }
    if (this.proxy !== null) {
      executionEnv.NIX_INSTALLER_PROXY = this.proxy;
    }
    if (this.sslCertFile !== null) {
      executionEnv.NIX_INSTALLER_SSL_CERT_FILE = this.sslCertFile;
    }
    executionEnv.NIX_INSTALLER_DIAGNOSTIC_ENDPOINT = (await this.getDiagnosticsUrl())?.toString() ?? "";
    if (this.macEncrypt !== null) {
      if (!this.isMacOS) {
        throw new Error("`mac-encrypt` while `$RUNNER_OS` was not `macOS`");
      }
      executionEnv.NIX_INSTALLER_ENCRYPT = this.macEncrypt;
    }
    if (this.macCaseSensitive !== null) {
      if (!this.isMacOS) {
        throw new Error(
          "`mac-case-sensitive` while `$RUNNER_OS` was not `macOS`"
        );
      }
      executionEnv.NIX_INSTALLER_CASE_SENSITIVE = this.macCaseSensitive;
    }
    if (this.macVolumeLabel !== null) {
      if (!this.isMacOS) {
        throw new Error(
          "`mac-volume-label` while `$RUNNER_OS` was not `macOS`"
        );
      }
      executionEnv.NIX_INSTALLER_VOLUME_LABEL = this.macVolumeLabel;
    }
    if (this.macRootDisk !== null) {
      if (!this.isMacOS) {
        throw new Error("`mac-root-disk` while `$RUNNER_OS` was not `macOS`");
      }
      executionEnv.NIX_INSTALLER_ROOT_DISK = this.macRootDisk;
    }
    if (this.logger !== null) {
      executionEnv.NIX_INSTALLER_LOGGER = this.logger;
    }
    if (this.logDirectives !== null) {
      executionEnv.NIX_INSTALLER_LOG_DIRECTIVES = this.logDirectives;
    }
    if (this.init !== null) {
      if (this.isMacOS) {
        throw new Error(
          "`init` is not a valid option when `$RUNNER_OS` is `macOS`"
        );
      }
      executionEnv.NIX_INSTALLER_INIT = this.init;
    }
    if (this.startDaemon !== null) {
      if (this.startDaemon) {
        executionEnv.NIX_INSTALLER_START_DAEMON = "true";
      } else {
        executionEnv.NIX_INSTALLER_START_DAEMON = "false";
      }
    }
    let extraConf = "";
    if (this.githubServerUrl !== null && this.githubToken !== null) {
      const serverUrl = this.githubServerUrl.replace("https://", "");
      extraConf += `access-tokens = ${serverUrl}=${this.githubToken}`;
      extraConf += "\n";
    }
    if (this.trustRunnerUser) {
      const user = userInfo().username;
      if (user) {
        extraConf += `trusted-users = root ${user}`;
      } else {
        extraConf += `trusted-users = root`;
      }
      extraConf += "\n";
    }
    extraConf += `build-provenance-tags = ${JSON.stringify(this.getBuildProvenanceTags())}
`;
    if (this.extraConf !== null && this.extraConf.length !== 0) {
      extraConf += this.extraConf.join("\n");
      extraConf += "\n";
    }
    executionEnv.NIX_INSTALLER_EXTRA_CONF = extraConf;
    if (this.isRunningInAct) {
      this.setAttribute(ATTR_IN_ACT, true);
      log2.info(
        "Detected `$ACT` environment, assuming this is a https://github.com/nektos/act created container, set `NOT_ACT=true` to override this. This will change the setting of the `init` to be compatible with `act`"
      );
      executionEnv.NIX_INSTALLER_INIT = "none";
    }
    if (this.isRunningInNamespaceRunner) {
      this.setAttribute(ATTR_IN_NAMESPACE_SO, true);
      log2.info(
        "Detected Namespace runner, assuming this is a https://namespace.so created container, set `NOT_NAMESPACE=true` to override this. This will change the setting of the `init` to be compatible with Namespace"
      );
      executionEnv.NIX_INSTALLER_INIT = "none";
    }
    return executionEnv;
  }
  getBuildProvenanceTags() {
    const mapping = {
      GITHUB_WORKFLOW_REF: "github_workflow_ref",
      GITHUB_WORKFLOW_SHA: "github_workflow_sha",
      GITHUB_SHA: "github_sha",
      GITHUB_RUN_ATTEMPT: "github_run_attempt",
      GITHUB_RUN_ID: "github_run_id",
      GITHUB_RUN_NUMBER: "github_run_number",
      GITHUB_JOB: "github_job",
      GITHUB_REF: "github_ref",
      GITHUB_REPOSITORY: "github_repository",
      GITHUB_SERVER_URL: "github_server_url"
    };
    const tags = Object.entries(mapping).map(([sourceKey, targetKey]) => [targetKey, process.env[sourceKey]]).filter(([_, value]) => value !== void 0);
    return { ...Object.fromEntries(tags), builder: "github-actions" };
  }
  get installerArgs() {
    const args = ["install"];
    if (this.planner) {
      this.setAttribute(ATTR_NIX_INSTALLER_PLANNER, this.planner);
      args.push(this.planner);
    } else {
      this.setAttribute(ATTR_NIX_INSTALLER_PLANNER, this.defaultPlanner);
      args.push(this.defaultPlanner);
    }
    if (this.extraArgs) {
      const extraArgs = stringArgv(this.extraArgs);
      args.push(...extraArgs);
    }
    if (this.determinate) {
      this.setAttribute(ATTR_DETERMINATE_NIX, true);
      log2.info(`Installing Determinate Nix using the ${FLAG_DETERMINATE} flag`);
      if (!this.extraArgs) {
        args.push(FLAG_DETERMINATE);
      }
      if (this.extraArgs && !this.extraArgs.includes(FLAG_DETERMINATE)) {
        args.push(FLAG_DETERMINATE);
      }
    } else {
      args.push(FLAG_PREFER_UPSTREAM_NIX);
    }
    return args;
  }
  async executeInstall(binaryPath) {
    return withSpan("execute_install", async (span) => {
      const executionEnv = await this.executionEnvironment();
      const exitCode = await actionsExec.exec(binaryPath, this.installerArgs, {
        env: {
          ...executionEnv,
          ...process.env,
          // To get $PATH, etc
          ...await this.getTelemetryEnvironment()
        }
      });
      span.setAttribute(ATTR_EXIT_CODE, exitCode);
      if (exitCode !== 0) {
        throw new Error(`Non-zero exit code of \`${exitCode}\` detected`);
      }
      return exitCode;
    });
  }
  async install() {
    return withSpan("install", async (span) => {
      const existingInstall = await this.detectExisting();
      if (existingInstall) {
        if (this.reinstall) {
          log2.info(
            "Nix was already installed, `reinstall` is set, uninstalling for a reinstall"
          );
          await this.executeUninstall();
        } else {
          await this.setGithubPath();
          if (this.determinate) {
            await this.flakehubLogin();
          }
          log2.info("Nix was already installed, using existing install");
          return;
        }
      }
      if (this.kvm) {
        const kvmEnabled = await this.setupKvm();
        span.setAttribute(ATTR_KVM_ENABLED, kvmEnabled);
        if (kvmEnabled) {
          log2.info("\x1B[32m Accelerated KVM is enabled \x1B[33m\u26A1\uFE0F");
          actionsCore.exportVariable("DETERMINATE_NIX_KVM", "1");
        } else {
          log2.info("KVM is not available.");
          actionsCore.exportVariable("DETERMINATE_NIX_KVM", "0");
        }
      }
      await log2.group("install_nix", "Installing Nix", async () => {
        const binaryPath = await this.fetchBinary();
        await this.executeInstall(binaryPath);
      });
      if (this.forceNoSystemd) {
        await this.spawnDetached();
      }
      await this.setGithubPath();
      if (this.determinate) {
        await this.flakehubLogin();
      }
    });
  }
  async spawnDetached() {
    return log2.group(
      "spawn_daemon",
      "Directly spawning the daemon, since systemd is not available.",
      async () => {
        const outputPath = path.join(this.daemonDir, "daemon.log");
        this.stapleFile("daemon.log", outputPath);
        const output = openSync(outputPath, "a");
        const daemonBin = this.determinate ? "/usr/local/bin/determinate-nixd" : "/nix/var/nix/profiles/default/bin/nix-daemon";
        const daemonCliFlags = this.determinate ? ["daemon"] : [];
        let executable;
        let args;
        if (userInfo().uid === 0) {
          executable = daemonBin;
          args = daemonCliFlags;
        } else {
          executable = "sudo";
          args = [daemonBin].concat(daemonCliFlags);
        }
        const opts = {
          stdio: ["ignore", output, output],
          detached: true,
          env: {
            ...process.env,
            ...await this.getTelemetryEnvironment()
          }
        };
        log2.debug("Full daemon start command:");
        log2.debug(`${executable} ${args.join(" ")}`);
        const daemon = spawn(executable, args, opts);
        const pidFile = path.join(this.daemonDir, "daemon.pid");
        if (daemon.pid) {
          this.setAttribute(ATTR_DAEMON_PID, daemon.pid);
          await writeFile(pidFile, daemon.pid.toString());
        }
        for (let i = 0; i <= 2400; i++) {
          if (daemon.signalCode !== null || daemon.exitCode !== null) {
            let msg;
            if (daemon.signalCode) {
              msg = `Daemon was killed by signal ${daemon.signalCode}`;
            } else {
              msg = `Daemon exited with code ${daemon.exitCode}`;
            }
            throw new Error(msg);
          }
          if (await this.doesTheSocketExistYet()) {
            break;
          }
          await setTimeout(50);
        }
        if (!await this.doesTheSocketExistYet()) {
          throw new Error("Timed out waiting for the daemon socket to appear.");
        }
        daemon.unref();
      }
    );
  }
  async doesTheSocketExistYet() {
    const socketPath = "/nix/var/nix/daemon-socket/socket";
    try {
      await stat(socketPath);
      return true;
    } catch (error) {
      if (error.code === "ENOENT") {
        log2.debug(`Socket '${socketPath}' does not exist yet`);
        return false;
      }
      log2.warning(
        `Error waiting for the Nix Daemon socket: ${stringifyError(error)}`
      );
      throw error;
    }
  }
  async summarizeExecution() {
    return withSpan("summarize_execution", async (span) => {
      const startDate = new Date(actionsCore.getState(STATE_START_DATETIME));
      const recent = await getRecentEvents(startDate);
      if (recent === void 0) {
        span.setAttribute(ATTR_SUMMARY_AVAILABLE, false);
        log2.debug(
          "determinate-nixd has no socket on this runner, so there is no build summary."
        );
        return;
      }
      span.setAttribute(ATTR_SUMMARY_AVAILABLE, true);
      const { events, hasMismatches } = recent;
      span.setAttribute("detsys.event_count", events.length);
      span.setAttribute("detsys.has_mismatches", hasMismatches);
      await this.reportPassFailCount(events);
      const mermaidSummary = makeMermaidReport(events);
      const failureSummary = await summarizeFailures(events);
      const showResults = mermaidSummary || failureSummary || hasMismatches;
      if (showResults) {
        actionsCore.summary.addRaw(
          `## ![](https://avatars.githubusercontent.com/u/80991770?s=30) Determinate Nix build summary`,
          true
        );
        actionsCore.summary.addRaw("\n", true);
      }
      if (mermaidSummary !== void 0) {
        actionsCore.summary.addRaw(mermaidSummary, true);
        actionsCore.summary.addRaw("\n", true);
      }
      if (hasMismatches) {
        actionsCore.summary.addRaw(
          [
            "> [!TIP]",
            "> Some derivations failed to build due to the hash in the Nix expression being outdated.",
            "> To find out how to automatically update your Nix expressions in GitHub Actions, see [our guide](https://docs.determinate.systems/guides/automatically-fix-hashes-in-github-actions).",
            ""
          ].join("\n"),
          true
        );
      }
      if (failureSummary !== void 0) {
        for (const logLine of failureSummary.logLines) {
          log2.info(logLine);
        }
        actionsCore.summary.addRaw(
          failureSummary.markdownLines.join("\n"),
          true
        );
        actionsCore.summary.addRaw("\n", true);
      }
      if (showResults) {
        actionsCore.summary.addRaw("---", true);
        actionsCore.summary.addRaw(
          `_Please let us know what you think about this summary on the [Determinate Systems Discord](https://determinate.systems/discord)._`,
          true
        );
        actionsCore.summary.addRaw("\n", true);
        await actionsCore.summary.write();
      }
    });
  }
  async reportPassFailCount(events) {
    let built = 0;
    let failed = 0;
    let unknown = 0;
    for (const event of events) {
      switch (event.c) {
        case "BuiltPathResponseEventV1":
          built++;
          break;
        case "BuildFailureResponseEventV1":
          failed++;
          break;
        default:
          unknown++;
      }
    }
    this.setAttribute(ATTR_BUILDS_SUCCEEDED, built);
    this.setAttribute(ATTR_BUILDS_FAILED, failed);
    this.setAttribute(ATTR_BUILDS_UNKNOWN_EVENT, unknown);
  }
  async setGithubPath() {
    try {
      const paths = [];
      if (this.determinate) {
        paths.push("/usr/local/bin");
      }
      paths.push("/nix/var/nix/profiles/default/bin");
      paths.push(`${process.env["HOME"]}/.nix-profile/bin`);
      for (const p of paths) {
        actionsCore.addPath(p);
        log2.debug(`Added \`${p}\` to \`$GITHUB_PATH\``);
      }
    } catch {
      log2.info(
        "Skipping setting $GITHUB_PATH in action, the `nix-installer` crate seems to have done this already. From `nix-installer` version 0.11.0 and up, this step is done in the action. Prior to 0.11.0, this was only done in the `nix-installer` binary."
      );
    }
  }
  async flakehubLogin() {
    return withSpan("flakehub_login", async (span) => {
      const canLogin = process.env["ACTIONS_ID_TOKEN_REQUEST_URL"] && process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
      if (!canLogin) {
        const pr = github.context.payload.pull_request;
        const base = pr?.base?.repo?.full_name;
        const head = pr?.head?.repo?.full_name;
        if (pr && base !== head) {
          span.setAttribute(ATTR_LOGIN_SKIPPED_REASON, "fork");
          log2.info(
            `FlakeHub is disabled because this is a fork. GitHub Actions does not allow OIDC authentication from forked repositories ("${head}" is not from the same repository as "${base}").`
          );
          return;
        }
        span.setAttribute(ATTR_LOGIN_SKIPPED_REASON, "not-configured");
        log2.info(
          "FlakeHub is disabled because the workflow is misconfigured. Please make sure that `id-token: write` and `contents: read` are set for this step's (or job's) permissions so that GitHub Actions provides OIDC token endpoints."
        );
        log2.info(
          `For more information, see https://docs.determinate.systems/guides/github-actions/#nix-installer-action`
        );
        return;
      }
      await log2.group(
        "determinate_nixd_login",
        "Logging in to FlakeHub",
        async () => {
          try {
            await actionsExec.exec(`determinate-nixd`, [
              "login",
              "github-action"
            ]);
            span.setAttribute(ATTR_LOGIN_SUCCEEDED, true);
          } catch (e) {
            span.setAttribute(ATTR_LOGIN_SUCCEEDED, false);
            log2.warning(`FlakeHub Login failure: ${stringifyError(e)}`);
            recordSpanError(span, e);
          }
        }
      );
    });
  }
  async executeUninstall() {
    return withSpan("uninstall", async (span) => {
      const exitCode = await actionsExec.exec(
        `/nix/nix-installer`,
        ["uninstall"],
        {
          env: {
            NIX_INSTALLER_NO_CONFIRM: "true",
            ...process.env,
            // To get $PATH, etc
            ...await this.getTelemetryEnvironment()
          }
        }
      );
      span.setAttribute("detsys.exit_code", exitCode);
      if (exitCode !== 0) {
        throw new Error(`Non-zero exit code of \`${exitCode}\` detected`);
      }
      return exitCode;
    });
  }
  async detectExisting() {
    return withSpan("detect_existing", async (span) => {
      const receiptPath = "/nix/receipt.json";
      try {
        await access(receiptPath);
        span.setAttribute("detsys.existing_install", true);
        log2.info(
          "\x1B[32m Nix is already installed: found /nix/receipt.json \x1B[33m"
        );
        return true;
      } catch {
      }
      try {
        const exitCode = await actionsExec.exec("nix", ["--version"], {});
        if (exitCode === 0) {
          span.setAttribute("detsys.existing_install", true);
          log2.info(
            "\x1B[32m Nix is already installed: `nix --version` exited 0 \x1B[33m"
          );
          return true;
        }
      } catch {
      }
      span.setAttribute("detsys.existing_install", false);
      return false;
    });
  }
  async canAccessKvm() {
    try {
      await access("/dev/kvm", fs.constants.R_OK | fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
  // The group is the span of this operation. The caller used to wrap the call
  // in a group of its own, which reported the same work twice.
  async setupKvm() {
    return log2.group("setup_kvm", "Configuring KVM", async ({ span }) => {
      const currentUser = userInfo();
      const isRoot = currentUser.uid === 0;
      const maybeSudo = isRoot ? "" : "sudo";
      span.setAttribute(ATTR_IS_ROOT, isRoot);
      if (await this.canAccessKvm()) {
        span.setAttribute("detsys.kvm_accessible", true);
        return true;
      }
      span.setAttribute("detsys.kvm_accessible", false);
      const kvmRules = "/etc/udev/rules.d/99-determinate-nix-installer-kvm.rules";
      try {
        const writeFileExitCode = await actionsExec.exec(
          "sh",
          [
            "-c",
            `echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' | ${maybeSudo} tee ${kvmRules} > /dev/null`
          ],
          {
            silent: true,
            listeners: {
              stdout: (data) => {
                const trimmed = data.toString("utf-8").trimEnd();
                if (trimmed.length >= 0) {
                  log2.debug(trimmed);
                }
              },
              stderr: (data) => {
                const trimmed = data.toString("utf-8").trimEnd();
                if (trimmed.length >= 0) {
                  log2.debug(trimmed);
                }
              }
            }
          }
        );
        if (writeFileExitCode !== 0) {
          throw new Error(
            `Non-zero exit code of \`${writeFileExitCode}\` detected while writing '${kvmRules}'`
          );
        }
        const debugRootRunThrow = async (action, command, args) => {
          if (!isRoot) {
            args = [command, ...args];
            command = "sudo";
          }
          const reloadExitCode = await actionsExec.exec(command, args, {
            silent: true,
            listeners: {
              stdout: (data) => {
                const trimmed = data.toString("utf-8").trimEnd();
                if (trimmed.length >= 0) {
                  log2.debug(trimmed);
                }
              },
              stderr: (data) => {
                const trimmed = data.toString("utf-8").trimEnd();
                if (trimmed.length >= 0) {
                  log2.debug(trimmed);
                }
              }
            }
          });
          if (reloadExitCode !== 0) {
            throw new Error(
              `Non-zero exit code of \`${reloadExitCode}\` detected while ${action}.`
            );
          }
        };
        await debugRootRunThrow("reloading udev rules", "udevadm", [
          "control",
          "--reload-rules"
        ]);
        await debugRootRunThrow("triggering udev against kvm", "udevadm", [
          "trigger",
          "--name-match=kvm"
        ]);
        return true;
      } catch {
        if (isRoot) {
          await actionsExec.exec("rm", ["-f", kvmRules]);
        } else {
          await actionsExec.exec("sudo", ["rm", "-f", kvmRules]);
        }
        return false;
      }
    });
  }
  async fetchBinary() {
    if (!this.localRoot) {
      return await this.fetchExecutable();
    } else {
      const localPath = join(this.localRoot, `nix-installer-${this.platform}`);
      log2.info(`Using binary ${localPath}`);
      return localPath;
    }
  }
  async cleanupNoSystemd() {
    return withSpan("cleanup_no_systemd", async (span) => {
      if (!this.forceNoSystemd) {
        return;
      }
      const pidFile = path.join(this.daemonDir, "daemon.pid");
      const pid = parseInt(await readFile(pidFile, { encoding: "ascii" }));
      log2.debug(`found daemon pid: ${pid}`);
      if (!pid) {
        throw new Error("the daemon did not start successfully");
      }
      span.setAttribute("detsys.daemon_pid", pid);
      log2.debug(`killing daemon process ${pid}`);
      try {
        for (let i = 0; i < 30 * 10; i++) {
          process.kill(pid, 0);
          await setTimeout(100);
        }
        span.setAttribute("detsys.sent_sigterm", true);
        this.setAttribute(ATTR_SENT_SIGTERM, true);
        log2.info(`Sending the daemon a SIGTERM`);
        process.kill(pid, "SIGTERM");
      } catch {
      }
      if (actionsCore.isDebug()) {
        log2.info("Entire log:");
        const entireLog = await readFile(
          path.join(this.daemonDir, "daemon.log"),
          "utf-8"
        );
        log2.info(entireLog);
      }
    });
  }
  async reportOverall() {
    this.setAttribute(ATTR_JOB_CONCLUSION, this.jobConclusion ?? "unknown");
  }
  get defaultPlanner() {
    if (this.isMacOS) {
      return "macos";
    } else if (this.isLinux) {
      return "linux";
    } else {
      throw new Error(
        `Unsupported \`RUNNER_OS\` (currently \`${this.runnerOs}\`)`
      );
    }
  }
  async annotateMismatches() {
    return withSpan("annotate_mismatches", async (span) => {
      if (!this.determinate) {
        return;
      }
      const active = this.getFeature(FEAT_ANNOTATIONS)?.variant;
      if (!active) {
        log2.debug("The annotations feature is disabled for this run");
        return;
      }
      try {
        log2.debug("Getting hash fixes from determinate-nixd");
        const since = actionsCore.getState(STATE_START_DATETIME);
        const mismatches = await getFixHashes(since);
        if (mismatches.version !== "v1") {
          throw new Error(
            `Unsupported \`determinate-nixd fix hashes\` output (got ${mismatches.version}, expected v1)`
          );
        }
        log2.debug("Annotating mismatches");
        const count = annotateMismatches(mismatches);
        span.setAttribute(ATTR_FOD_MISMATCH_COUNT, count);
      } catch (error) {
        log2.warning(`Could not consume hash mismatch events: ${error}`);
        recordSpanError(span, error);
      }
    });
  }
};
function main() {
  new NixInstallerAction().execute();
}
main();
