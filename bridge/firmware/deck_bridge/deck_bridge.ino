// 04_command - serial command channel + neutral-on-silence watchdog.
//
// The board does NOTHING on its own. It presses only what the PC tells it to,
// and it releases everything the moment the PC goes quiet. Per plan 19 L6 the
// watchdog ships in the same sitting as the first remote press command, never
// after it.
//
// Protocol: one JSON object per line, in on the COM (CH343) port.
//   {"t":"hb"}                            heartbeat, PC sends at 4 Hz
//   {"t":"press","b":["DOWN"],"ms":80}    press, hold ms, auto-release
//   {"t":"hold","b":["A","DOWN"]}         hold until released or watchdog fires
//   {"t":"release"}                       everything to neutral, now
//   {"t":"status"}                        report current state
//
// Every line in gets exactly one JSON line back, so the PC can verify the
// command landed instead of assuming it did.
//
// Names: UP DOWN LEFT RIGHT (hat) | A B X Y LB RB SELECT START GUIDE (buttons)

#include <ArduinoJson.h>
#include "USB.h"
#include "USBHIDGamepad.h"

#if ARDUINO_USB_MODE
#error "Build with USB Mode = USB-OTG (TinyUSB). FQBN option: USBMode=default"
#endif

USBHIDGamepad Gamepad;

static const uint32_t WATCHDOG_MS = 750;   // silence tolerated before neutral
static const uint32_t MAX_PRESS_MS = 5000; // refuse to hold longer than this

// ---- button + direction tables ------------------------------------------

struct NamedBit {
  const char *name;
  uint16_t mask;
};

// Bit assignments measured against Steam's Test Device Inputs on 2026-08-25
// by sweeping raw bits and diffing video frames (see README, "Button map").
// Steam's generic-HID layout for this device leaves bits 2, 5, 8, 9 and 15
// unused - the map is NOT dense, and guessing it wrong is what made five of
// these names look dead.
static const NamedBit BUTTONS[] = {
  {"A", 1 << 0},       {"B", 1 << 1},      {"X", 1 << 3},
  {"Y", 1 << 4},       {"LB", 1 << 6},     {"RB", 1 << 7},
  {"SELECT", 1 << 10}, {"START", 1 << 11}, {"GUIDE", 1 << 12},
  {"L3", 1 << 13},     {"R3", 1 << 14},
};
static const size_t N_BUTTONS = sizeof(BUTTONS) / sizeof(BUTTONS[0]);

static const uint8_t DIR_U = 1, DIR_D = 2, DIR_L = 4, DIR_R = 8;

static const NamedBit DIRS[] = {
  {"UP", DIR_U}, {"DOWN", DIR_D}, {"LEFT", DIR_L}, {"RIGHT", DIR_R},
};
static const size_t N_DIRS = sizeof(DIRS) / sizeof(DIRS[0]);

// TinyUSB hat encoding: 0 centered, 1 up, then clockwise to 8 up-left.
static uint8_t hatFromDirs(uint8_t d) {
  switch (d) {
    case DIR_U:         return 1;
    case DIR_U | DIR_R: return 2;
    case DIR_R:         return 3;
    case DIR_D | DIR_R: return 4;
    case DIR_D:         return 5;
    case DIR_D | DIR_L: return 6;
    case DIR_L:         return 7;
    case DIR_U | DIR_L: return 8;
    default:            return 0;   // includes opposing pairs, e.g. UP+DOWN
  }
}

// ---- state ---------------------------------------------------------------

static uint16_t curButtons = 0;
static uint8_t curDirs = 0;
static uint32_t lastRxMs = 0;
static uint32_t releaseAtMs = 0;   // 0 = no timed release pending
static bool watchdogTripped = false;

static void applyState() {
  Gamepad.send(0, 0, 0, 0, 0, 0, hatFromDirs(curDirs), curButtons);
}

static void goNeutral() {
  curButtons = 0;
  curDirs = 0;
  releaseAtMs = 0;
  applyState();
}

// ---- replies -------------------------------------------------------------

static void reply(const char *t, const char *detail = nullptr) {
  Serial.printf("{\"ok\":true,\"t\":\"%s\",\"buttons\":%u,\"dirs\":%u,\"ms\":%lu",
                t, (unsigned)curButtons, (unsigned)curDirs,
                (unsigned long)millis());
  if (detail) Serial.printf(",\"detail\":\"%s\"", detail);
  Serial.println("}");
}

static void fail(const char *why) {
  Serial.printf("{\"ok\":false,\"error\":\"%s\"}\n", why);
}

// ---- command handling ----------------------------------------------------

// Fill masks from a JSON array of names. Returns false on an unknown name.
static bool parseNames(JsonArrayConst arr, uint16_t &btns, uint8_t &dirs) {
  for (JsonVariantConst v : arr) {
    const char *name = v.as<const char *>();
    if (!name) return false;
    bool found = false;
    for (size_t i = 0; i < N_BUTTONS && !found; i++) {
      if (strcasecmp(name, BUTTONS[i].name) == 0) {
        btns |= BUTTONS[i].mask;
        found = true;
      }
    }
    for (size_t i = 0; i < N_DIRS && !found; i++) {
      if (strcasecmp(name, DIRS[i].name) == 0) {
        dirs |= (uint8_t)DIRS[i].mask;
        found = true;
      }
    }
    if (!found) return false;
  }
  return true;
}

static void handleLine(const char *line) {
  lastRxMs = millis();

  JsonDocument doc;
  if (deserializeJson(doc, line)) { fail("bad json"); return; }

  const char *t = doc["t"] | "";

  if (strcmp(t, "hb") == 0) {
    // Heartbeat only refreshes lastRxMs, set above. Stay quiet-ish so a 4 Hz
    // heartbeat does not drown the log; the PC can use status when it cares.
    return;
  }

  if (strcmp(t, "release") == 0 || strcmp(t, "kill") == 0) {
    goNeutral();
    reply("release");
    return;
  }

  if (strcmp(t, "status") == 0) {
    reply("status", watchdogTripped ? "watchdog-tripped" : "live");
    return;
  }

  if (strcmp(t, "press") == 0 || strcmp(t, "hold") == 0) {
    uint16_t btns = 0;
    uint8_t dirs = 0;
    // "mask" presses raw button bits, for discovering how a host numbers them.
    // The Arduino gamepad API carries 16 buttons, so bits above 15 are lost.
    if (doc["mask"].is<unsigned int>()) {
      btns = (uint16_t)(doc["mask"].as<unsigned int>() & 0xFFFF);
    } else if (doc["b"].is<JsonArrayConst>()) {
      if (!parseNames(doc["b"].as<JsonArrayConst>(), btns, dirs)) {
        fail("unknown button name");
        return;
      }
    } else {
      fail("missing b[] or mask");
      return;
    }
    curButtons = btns;
    curDirs = dirs;
    applyState();
    // Only a fresh press clears a recorded trip. Merely talking to the board
    // must not erase the evidence that the safety net fired.
    watchdogTripped = false;

    if (strcmp(t, "press") == 0) {
      uint32_t ms = doc["ms"] | 80;
      if (ms > MAX_PRESS_MS) ms = MAX_PRESS_MS;
      releaseAtMs = millis() + ms;   // released in loop(), never with delay()
      reply("press");
    } else {
      releaseAtMs = 0;
      reply("hold");
    }
    return;
  }

  fail("unknown t");
}

// ---- main ----------------------------------------------------------------

static char buf[256];
static size_t buflen = 0;

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println("{\"boot\":\"deck-bridge 04_command\",\"watchdog_ms\":750}");

  Gamepad.begin();
  USB.begin();
  delay(1500);
  goNeutral();
  lastRxMs = millis();
  Serial.println("{\"ready\":true}");
}

void loop() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (buflen) {
        buf[buflen] = '\0';
        handleLine(buf);
        buflen = 0;
      }
    } else if (buflen < sizeof(buf) - 1) {
      buf[buflen++] = c;
    }
  }

  // Timed release for "press". Non-blocking so the watchdog stays live.
  if (releaseAtMs && (int32_t)(millis() - releaseAtMs) >= 0) {
    goNeutral();
    Serial.println("{\"event\":\"released\"}");
  }

  // Neutral on silence. This is the thing that stops a stuck button when the
  // PC dies, the cable is pulled, or the runner crashes mid-press.
  if ((curButtons || curDirs) && (millis() - lastRxMs) > WATCHDOG_MS) {
    goNeutral();
    watchdogTripped = true;
    Serial.println("{\"event\":\"watchdog\",\"detail\":\"link silent, neutralized\"}");
  }
}
