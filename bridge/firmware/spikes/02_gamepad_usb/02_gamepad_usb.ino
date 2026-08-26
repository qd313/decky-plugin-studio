// 02_gamepad_usb - spike S1: will the Deck accept this board as a controller?
//
// Presents a generic USB HID gamepad on the native "USB" port and walks the
// D-pad down twice, then up twice, forever.
//
// SAFE TO LEAVE RUNNING ON THE DECK: net movement per cycle is zero and no
// buttons are pressed, so it can move a highlight but cannot activate
// anything. Every press returns to neutral before the next step.
//
// Cables: "COM" -> PC (flashing + the log below).
//         "USB" -> Deck dock, or a PC for the joy.cpl check.

#include "USB.h"
#include "USBHIDGamepad.h"

#if ARDUINO_USB_MODE
#error "Build with USB Mode = USB-OTG (TinyUSB). FQBN option: USBMode=default"
#endif

// Flip to 1 ONLY while testing against a PC. Leave 0 for the Deck, where a
// stray A press could activate whatever is highlighted.
#define ENABLE_BUTTON_TEST 0

USBHIDGamepad Gamepad;

static const uint8_t PAD_HAT_CENTER = 0;
static const uint8_t PAD_HAT_UP = 1;
static const uint8_t PAD_HAT_DOWN = 5;
static const uint16_t PAD_BTN_A = 1 << 0;

// Send one input and always come back to neutral.
static void tap(const char *what, uint8_t hat, uint16_t buttons, uint16_t holdMs) {
  Serial.printf("[%8lu] %s\n", (unsigned long)millis(), what);
  Gamepad.send(0, 0, 0, 0, 0, 0, hat, buttons);
  delay(holdMs);
  Gamepad.send(0, 0, 0, 0, 0, 0, PAD_HAT_CENTER, 0);
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println("deck-bridge S1: generic USB HID gamepad");
  Serial.println("watch the Deck UI highlight, or Win+R -> joy.cpl on a PC");

  Gamepad.begin();
  USB.begin();
  delay(1500);  // give the host time to enumerate before the first press
  Serial.println("USB up");
}

void loop() {
  tap("D-pad DOWN", PAD_HAT_DOWN, 0, 80);
  delay(1500);
  tap("D-pad DOWN", PAD_HAT_DOWN, 0, 80);
  delay(1500);
  tap("D-pad UP", PAD_HAT_UP, 0, 80);
  delay(1500);
  tap("D-pad UP", PAD_HAT_UP, 0, 80);
  delay(1500);

#if ENABLE_BUTTON_TEST
  tap("button A (PC test only)", PAD_HAT_CENTER, PAD_BTN_A, 80);
  delay(1500);
#endif

  Serial.println("--- cycle complete, back to start ---");
}
