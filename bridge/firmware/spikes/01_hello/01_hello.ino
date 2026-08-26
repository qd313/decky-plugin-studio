// 01_hello - proves the board is alive and the COM port carries a log.
//
// Serial goes out the CH343 ("COM") port, not the native one, because the
// build sets USB CDC On Boot = Disabled. That keeps the native "USB" port
// free to be a controller later.

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println("deck-bridge: hello");
  Serial.printf("chip : %s rev %d, %d cores\n",
                ESP.getChipModel(), ESP.getChipRevision(), ESP.getChipCores());
  Serial.printf("flash: %u MB\n", (unsigned)(ESP.getFlashChipSize() / (1024 * 1024)));
  Serial.printf("psram: %u MB\n", (unsigned)(ESP.getPsramSize() / (1024 * 1024)));
}

void loop() {
  static unsigned long n = 0;
  Serial.printf("tick %lu  up %lu ms\n", ++n, (unsigned long)millis());
  delay(1000);
}
