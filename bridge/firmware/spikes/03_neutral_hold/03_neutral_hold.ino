// 03_neutral_hold - DIAGNOSTIC. Presents the gamepad, then does nothing at all.
//
// One absolute-neutral report per second and nothing else: hat centered, all
// six axes at 0, no buttons pressed, ever.
//
// The test: if the Deck STILL scrolls with this running, the problem is not our
// presses. It is that the host does not read our "centered" hat as centered.
//
// Suspect: TinyUSB's stock gamepad report descriptor declares the hat as
// LOGICAL_MIN(1) LOGICAL_MAX(8) with no null-state flag. That leaves 0 - the
// value everyone uses for "centered" - formally out of range. Windows treats
// out-of-range as centered (it did, we watched it). A stricter parser can clamp
// it to the minimum instead, and the minimum is 1, which is UP.

#include "USB.h"
#include "USBHIDGamepad.h"

#if ARDUINO_USB_MODE
#error "Build with USB Mode = USB-OTG (TinyUSB). FQBN option: USBMode=default"
#endif

USBHIDGamepad Gamepad;

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println("deck-bridge: NEUTRAL HOLD (diagnostic, presses nothing)");
  Gamepad.begin();
  USB.begin();
  delay(1500);
  Serial.println("USB up - holding neutral forever");
}

void loop() {
  // hat 0 = centered, all axes 0, no buttons. This is our idea of "at rest".
  Gamepad.send(0, 0, 0, 0, 0, 0, 0, 0);
  Serial.printf("[%8lu] neutral\n", (unsigned long)millis());
  delay(1000);
}
