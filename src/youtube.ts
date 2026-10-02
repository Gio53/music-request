import crypto from "crypto";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { DOWNLOAD_DIR } from "./config";
import { getSetting } from "./db";
import { ServiceError } from "./errors";

function downloadRoot(): string {
  const configured = DOWNLOAD_DIR || getSetting("download_path") || getSetting("lidarr_root_folder");
  if (!configured) {
    throw new ServiceError(
      "youtube",
      "Choose a Lidarr root folder, or set DOWNLOAD_DIR, before downloading from YouTube.",
    );
  }
  return path.resolve(configured);
}

function safeSegment(value: string): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  if (!cleaned || cleaned === "." || cleaned === "..") {
    throw new ServiceError("youtube", "That name cannot be used as a music folder.");
  }
  return cleaned;
}

function assertInside(root: string, target: string) {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ServiceError("youtube", "Refusing to write outside the music folder.");
  }
}

function oneLine(value: string): string {
  return value.replace(/[\r\n\u0000]/g, " ").trim();
}

function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  onText?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ServiceError("youtube", "Cancelled."));
      return;
    }
    const child = spawn(command, args, { windowsHide: true });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new ServiceError("youtube", `${command} took too long and was stopped.`));
    }, timeoutMs);
    const stop = () => child.kill();
    signal?.addEventListener("abort", stop);
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    };
    child.stdout.on("data", (chunk: Buffer) => onText?.(chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr = (stderr + text).slice(-1500);
      onText?.(text);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish();
      if (signal?.aborted) {
        reject(new ServiceError("youtube", "Cancelled."));
        return;
      }
      if (error.code === "ENOENT") {
        reject(
          new ServiceError(
            "youtube",
            command === "ffmpeg"
              ? "ffmpeg is not installed, so the song could not be saved."
              : "yt-dlp is not installed. The Docker image includes it.",
          ),
        );
        return;
      }
      reject(new ServiceError("youtube", error.message));
    });
    child.on("close", (code) => {
      finish();
      if (signal?.aborted) {
        reject(new ServiceError("youtube", "Cancelled."));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim().split("\n").slice(-2).join(" ");
      reject(new ServiceError("youtube", detail || `${command} exited with code ${code}.`));
    });
  });
}

export async function downloadTrack(input: {
  artist: string;
  title: string;
  album: string;
  position?: number;
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}): Promise<"downloaded" | "exists"> {
  const root = downloadRoot();
  const artist = safeSegment(input.artist);
  const album = safeSegment(input.album);
  const title = safeSegment(input.title);
  const fileName = input.position
    ? `${String(input.position).padStart(2, "0")} - ${title}.m4a`
    : `${title}.m4a`;
  const directory = path.join(root, artist, album);
  const finalPath = path.join(directory, fileName);
  assertInside(root, finalPath);
  if (fs.existsSync(finalPath)) {
    input.onProgress?.(100);
    return "exists";
  }

  fs.mkdirSync(directory, { recursive: true });
  const tempStem = `.mr-${crypto.randomBytes(4).toString("hex")}`;
  const tempPath = path.join(directory, `${tempStem}.m4a`);
  assertInside(root, tempPath);
  const query = `ytsearch5:${oneLine(input.artist)} - ${oneLine(input.title)}`.slice(0, 300);
  await runCommand(
    process.env.YT_DLP_PATH || "yt-dlp",
    [
      "--newline",
      "--no-playlist",
      "--no-warnings",
      "--max-downloads",
      "1",
      "--match-filter",
      "duration < 1200",
      "-x",
      "--audio-format",
      "m4a",
      "--audio-quality",
      "0",
      "-o",
      path.join(directory, `${tempStem}.%(ext)s`),
      query,
    ],
    180000,
      (chunk) => {
      const match = chunk.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
      if (!match) return;
      input.onProgress?.(Math.max(0, Math.min(100, Number(match[1]))));
    },
    input.signal,
  );

  const downloadedName = fs.readdirSync(directory).find((name) => name.startsWith(`${tempStem}.`));
  if (!downloadedName) {
    throw new ServiceError("youtube", `YouTube had no matching audio for ${input.artist} — ${input.title}.`);
  }
  const downloadedPath = path.join(directory, downloadedName);
  assertInside(root, downloadedPath);
  let tagged = false;
  try {
    await runCommand(
      "ffmpeg",
      [
        "-y",
        "-i",
        downloadedPath,
        "-c",
        "copy",
        "-metadata",
        `artist=${oneLine(input.artist)}`,
        "-metadata",
        `title=${oneLine(input.title)}`,
        "-metadata",
        `album=${oneLine(input.album)}`,
        ...(input.position ? ["-metadata", `track=${input.position}`] : []),
        finalPath,
      ],
      60000,
      undefined,
      input.signal,
    );
    tagged = fs.existsSync(finalPath);
  } catch (error) {
    if (input.signal?.aborted) {
      if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
      if (fs.existsSync(downloadedPath)) fs.unlinkSync(downloadedPath);
      throw error;
    }
    tagged = false;
    if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
  }
  if (!tagged && fs.existsSync(downloadedPath) && downloadedPath !== finalPath) {
    fs.renameSync(downloadedPath, finalPath);
  } else if (tagged && downloadedPath !== finalPath && fs.existsSync(downloadedPath)) {
    fs.unlinkSync(downloadedPath);
  }
  if (!fs.existsSync(finalPath)) {
    throw new ServiceError("youtube", `The song file for ${input.title} was not saved.`);
  }
  return "downloaded";
}
