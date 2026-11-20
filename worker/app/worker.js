const LISTENING_PORT = process.env.LISTENING_PORT || 3501;
const STAT_CPU_INTERVAL = process.env.STAT_CPU_INTERVAL || 2000;
const STAT_CPU_OPS_DURATION = process.env.STAT_CPU_OPS_DURATION || 1000;
var fs = require("fs");
const path = require("path");
const ORCHESTRATOR_URL =
	process.env.ORCHESTRATOR_URL || "http://localhost:3500";
const TRANSCODER_PATH =
	process.env.TRANSCODER_PATH || "/usr/lib/plexmediaserver/";
const TRANSCODER_NAME = process.env.TRANSCODER_NAME || "Plex Transcoder";
const EAE_SUPPORT = process.env.EAE_SUPPORT || "1";
const CODECS_PATH = process.env.CODECS_PATH || "/codecs";
// Auto-discover EAE binary from codecs directory if not explicitly set
function findEAEBinary() {
	if (process.env.EAE_EXECUTABLE) return process.env.EAE_EXECUTABLE;
	try {
		const dirs = fs.readdirSync(CODECS_PATH);
		for (const dir of dirs) {
			const eaePath = `${CODECS_PATH}/${dir}/EasyAudioEncoder/EasyAudioEncoder/EasyAudioEncoder`;
			if (fs.existsSync(eaePath)) {
				console.log(`EAE Support - Auto-discovered EAE binary: ${eaePath}`);
				return eaePath;
			}
		}
	} catch (e) { /* codecs dir may not exist */ }
	return "";
}
const EAE_EXECUTABLE = findEAEBinary();
// Kept in container-local storage (not the /codecs PVC) so a stale PID can't survive pod restarts
const EAE_PID_FILE =
	process.env.EAE_PID_FILE || "/run/clusterplex/easy-audio-encoder.pid";
try {
	fs.mkdirSync(path.dirname(EAE_PID_FILE), { recursive: true });
} catch (err) {
	console.error(`EAE Support - Unable to create PID directory: ${err.message}`);
}
// hwaccel decoder: https://trac.ffmpeg.org/wiki/HWAccelIntro
const FFMPEG_HWACCEL = process.env.FFMPEG_HWACCEL || false;
// hwaccel encoder: replace software encoder with hardware encoder (e.g. "h264_nvenc")
const FFMPEG_HWENC = process.env.FFMPEG_HWENC || false;

// Settings debug info
console.log(`EAE_SUPPORT => ${EAE_SUPPORT}`);
console.log(`EAE_EXECUTABLE => ${EAE_EXECUTABLE}`);
console.log(`FFMPEG_HWACCEL => ${FFMPEG_HWACCEL}`);
console.log(`FFMPEG_HWENC => ${FFMPEG_HWENC}`);

var app = require("express")();
var server = require("http").createServer(app);
var socket = require("socket.io-client")(ORCHESTRATOR_URL);
var cpuStat = require("cpu-stat");
const { spawn, exec } = require("child_process");
const { v4: uuid } = require("uuid");
const { fib, dist } = require("cpu-benchmark");

var ON_DEATH = require("death")({ debug: true });

// initialize CPU stats to a high number until it is overwritten by first sample
let cpuUsage = 9999.0;

// calculate CPU operations for worker stats (simple benchmark over STAT_CPU_OPS_DURATION milliseconds)
const ops = dist(STAT_CPU_OPS_DURATION);
console.log(`Computed CPU ops => ${ops}`);

// healthcheck endpoint
app.get("/health", (req, res) => {
	res.send("Healthy");
});

server.listen(LISTENING_PORT, () => {
	console.log(`Worker listening on port ${LISTENING_PORT}`);
});

// calculate cpu usage every 2 seconds
setInterval(() => {
	cpuStat.usagePercent(
		{ sampleMs: STAT_CPU_INTERVAL },
		(err, percent, seconds) => {
			if (!err) {
				cpuUsage = percent.toFixed(2);
				if (socket.connected) {
					socket.emit("worker.stats", {
						cpu: cpuUsage,
						tasks: taskMap.size,
						ops: ops,
					});
				}
			}
		}
	);
}, STAT_CPU_INTERVAL);

let workerId = uuid();
let taskMap = new Map();
let currentEAERoot;
let currentEAEProcess;

console.debug(`Initializing Worker ${workerId}|${process.env.HOSTNAME}`);

socket.on("connect", () => {
	console.log(`Worker connected on socket ${socket.id}`);
	socket.emit("worker.announce", {
		workerId: workerId,
		host: process.env.HOSTNAME,
	});
});

function processEnv(env) {
	// overwrite environment settings coming from the original plex instance tied to architecture
	newEnv = JSON.parse(JSON.stringify(env));
	newEnv.PLEX_ARCH = process.env.PLEX_ARCH;
	newEnv.PLEX_MEDIA_SERVER_INFO_MODEL =
		process.env.PLEX_MEDIA_SERVER_INFO_MODEL;
	newEnv.FFMPEG_EXTERNAL_LIBS = process.env.FFMPEG_EXTERNAL_LIBS;
	return newEnv;
}

socket.on("worker.task.request", (taskRequest) => {
	console.log("Received task request");

	socket.emit("worker.task.update", {
		taskId: taskRequest.taskId,
		status: "received",
	});

	var processedEnvironmentVariables = processEnv(taskRequest.payload.env);

	var child;
	if (taskRequest.payload.args[0] === "testpayload") {
		console.log(`args => ${JSON.stringify(taskRequest.payload.args)}`);
		console.log(`env => ${JSON.stringify(processedEnvironmentVariables)}`);
		console.log("Starting test of waiting for 5 seconds");
		child = exec("sleep 5");
	} else {
		if (FFMPEG_HWACCEL != false) {
			console.log(`Setting hwaccel to ${FFMPEG_HWACCEL}`);
			let i = taskRequest.payload.args.indexOf("-hwaccel");
			if (i > 0) {
				taskRequest.payload.args[i + 1] = FFMPEG_HWACCEL;
			} else {
				taskRequest.payload.args.unshift("-hwaccel", FFMPEG_HWACCEL);
			}
		}

		// Replace software encoder with hardware encoder
		if (FFMPEG_HWENC != false) {
			const args = taskRequest.payload.args;
			for (let i = 0; i < args.length; i++) {
				// Replace libx264 with NVENC h264 encoder
				if (args[i].match(/^-codec:\d+$/) && args[i + 1] === "libx264") {
					const codecFlag = args[i];
					const streamIdx = codecFlag.split(":")[1];
					console.log(`Replacing encoder libx264 -> ${FFMPEG_HWENC} for stream ${streamIdx}`);
					args[i + 1] = FFMPEG_HWENC;
					forceIdr(args, streamIdx);

					// Replace -crf with -cq (NVENC constant quality)
					for (let j = 0; j < args.length; j++) {
						if (args[j] === `-crf:${streamIdx}`) {
							console.log(`Replacing -crf:${streamIdx} -> -cq:${streamIdx} (value: ${args[j + 1]})`);
							args[j] = `-cq:${streamIdx}`;
						}
						// Replace x264-specific preset with NVENC preset
						if (args[j] === `-preset:${streamIdx}`) {
							const oldPreset = args[j + 1];
							// Map x264 presets to NVENC presets (p1=fastest, p7=slowest)
							const presetMap = {
								ultrafast: "p1", superfast: "p2", veryfast: "p3",
								faster: "p4", fast: "p5", medium: "p5",
								slow: "p6", slower: "p7", veryslow: "p7"
							};
							const newPreset = presetMap[oldPreset] || "p4";
							console.log(`Replacing preset ${oldPreset} -> ${newPreset} for stream ${streamIdx}`);
							args[j + 1] = newPreset;
						}
						// Remove x264opts (not compatible with NVENC)
						if (args[j] === `-x264opts:${streamIdx}`) {
							console.log(`Removing -x264opts:${streamIdx} ${args[j + 1]}`);
							args.splice(j, 2);
							j--;
						}
					}
				}
				// Replace libx265 with NVENC hevc encoder
				if (args[i].match(/^-codec:\d+$/) && args[i + 1] === "libx265") {
					const streamIdx = args[i].split(":")[1];
					const hevcEncoder = FFMPEG_HWENC.replace("h264_nvenc", "hevc_nvenc");
					console.log(`Replacing encoder libx265 -> ${hevcEncoder} for stream ${streamIdx}`);
					args[i + 1] = hevcEncoder;
					forceIdr(args, streamIdx);
				}
			}
		}

		console.log(`EAE_ROOT => "${processedEnvironmentVariables.EAE_ROOT}"`);
		if (
			(EAE_SUPPORT == "1" || EAE_SUPPORT == "true") &&
			EAE_EXECUTABLE != "" &&
			processedEnvironmentVariables.EAE_ROOT?.length > 0
		) {
			if (!fs.existsSync(processedEnvironmentVariables.EAE_ROOT)) {
				console.log(
					`EAE Support - Creating EAE_ROOT destination => ${processedEnvironmentVariables.EAE_ROOT}`
				);
				fs.mkdirSync(processedEnvironmentVariables.EAE_ROOT, {
					recursive: true,
				});
			}

			// PMS restarts produce a new EAE_ROOT; EAE must be restarted there or its watchfolder never exists
			if (
				currentEAERoot &&
				currentEAERoot != processedEnvironmentVariables.EAE_ROOT
			) {
				console.log(
					`EAE Support - EAE_ROOT changed => "${currentEAERoot}" to "${processedEnvironmentVariables.EAE_ROOT}"`
				);
				if (currentEAEProcess) {
					console.log("EAE Support - Killing previous EasyAudioEncoder");
					currentEAEProcess.kill();
				}
				currentEAEProcess = undefined;
				currentEAERoot = undefined;
				deleteEAE_PID();
			}

			if (fs.existsSync(EAE_PID_FILE)) {
				console.log(`EAE Support - EAE already running`);
			} else {
				console.log(
					`EAE Support - Spawning EasyAudioEncoder from "${EAE_EXECUTABLE}", cwd => ${processedEnvironmentVariables.EAE_ROOT}`
				);
				const childEAE = spawn(EAE_EXECUTABLE, [], {
					cwd: processedEnvironmentVariables.EAE_ROOT,
					env: processedEnvironmentVariables,
				});
				currentEAEProcess = childEAE;
				currentEAERoot = processedEnvironmentVariables.EAE_ROOT;
				childEAE.stdout.pipe(process.stdout);
				childEAE.stderr.pipe(process.stderr);
				// Ignore events from a previously-killed EAE so they don't delete the new one's PID
				const onEAEEnded = () => {
					if (currentEAEProcess === childEAE) {
						currentEAEProcess = undefined;
						currentEAERoot = undefined;
						deleteEAE_PID();
					}
				};
				childEAE.on("error", (err) => {
					console.error("EAE Support - EAE failed:");
					console.error(err);
					onEAEEnded();
				});
				childEAE.on("close", () => {
					console.log("EAE Support - Closing");
					onEAEEnded();
				});
				childEAE.on("exit", () => {
					console.log("EAE Support - Exiting");
					onEAEEnded();
				});

				createEAE_PID(childEAE.pid.toString());
			}
		}

		if (!fs.existsSync(taskRequest.payload.cwd)) {
			console.error(
				`CWD path doesn't seem to exist. Plex should have created this path before-hand, so you may have an issue with your shares => "${taskRequest.payload.cwd}"`
			);
		}

		child = spawn(
			TRANSCODER_PATH + TRANSCODER_NAME,
			taskRequest.payload.args,
			{
				cwd: taskRequest.payload.cwd,
				env: processedEnvironmentVariables,
			}
		);
	}

	taskMap.set(taskRequest.taskId, {
		transcodeProcess: child,
	});

	child.stdout.pipe(process.stdout);
	child.stderr.pipe(process.stderr);

	let notified = false;
	const completionHandler = (code) => {
		if (!notified) {
			console.log("Completed transcode");
			socket.emit("worker.task.update", {
				taskId: taskRequest.taskId,
				status: "done",
				result: code === 0,
				exitCode: code,
			});
			notified = true;
			console.log("Removing process from taskMap");
			taskMap.delete(taskRequest.taskId);
		}
	};

	child.on("error", (err) => {
		console.error("Transcoding failed:");
		console.error(err);
		notified = true;
		socket.emit("worker.task.update", {
			taskId: taskRequest.taskId,
			status: "done",
			result: false,
			error: err.message,
		});
		console.log("Orchestrator notified");

		console.log("Removing process from taskMap");
		taskMap.delete(taskRequest.taskId);
	});

	child.on("close", (c) => {
		console.log(`Transcoder close: child process exited with code ${c}`);
		completionHandler(c);
	});
	child.on("exit", (c) => {
		console.log(`Transcoder exit: child process exited with code ${c}`);
		completionHandler(c);
	});

	socket.emit("worker.task.update", {
		taskId: taskRequest.taskId,
		status: "inprogress",
	});
});

socket.on("worker.task.kill", (data) => {
	let taskEntry = taskMap.get(data.taskId);
	if (taskEntry) {
		console.log(`Killing child processes for task ${data.taskId}`);
		taskEntry.transcodeProcess.kill();
		console.log("Removing process from taskMap");
		taskMap.delete(data.taskId);
	}
});

socket.on("disconnect", () => {
	console.log("Worker disconnected");
});

ON_DEATH((signal, err) => {
	console.log("ON_DEATH signal detected");
	console.error(err);
	deleteEAE_PID();
	let exitCode = 0;
	switch (signal) {
		case "SIGINT":
			exitCode = 130;
			break;
		case "SIGQUIT":
			exitCode = 131;
			break;
		case "SIGTERM":
			exitCode = 143;
			break;
		default:
			exitCode = 1;
			break;
	}
	process.exit(exitCode);
});

// NVENC encodes -force_key_frames as non-IDR I-frames unless forced-idr is set, so the DASH
// muxer can't split there and segments fall back to the default 250-frame GOP, which no longer
// match the fixed segment durations in Plex's manifest and leave playback gaps.
function forceIdr(args, streamIdx) {
	const flag = `-forced-idr:${streamIdx}`;
	if (args.includes(flag)) return;
	const codecPos = args.indexOf(`-codec:${streamIdx}`, args.indexOf("-i"));
	if (codecPos < 0) return;
	console.log(`Adding ${flag} 1 so forced keyframes are IDR segment boundaries`);
	args.splice(codecPos + 2, 0, flag, "1");
}

function deleteEAE_PID() {
	if (fs.existsSync(EAE_PID_FILE)) {
		console.log("Removing EAE PID file");
		fs.unlinkSync(EAE_PID_FILE);
	}
}

function createEAE_PID(pid) {
	console.log("EAE Support - Writing PID file");
	try {
		fs.writeFileSync(EAE_PID_FILE, pid);
	} catch (err) {
		console.error(`EAE Support - Unable to write PID file ${EAE_PID_FILE}: ${err.message}`);
	}
}
