import decky


class Plugin:
    settings: dict = {"greeted": False}

    async def _main(self):
        decky.logger.info("Example plugin loaded (preview sidecar)")

    async def _unload(self):
        decky.logger.info("Example plugin unloading")

    async def get_greeting(self, name: str = "Decky dev"):
        self.settings["greeted"] = True
        return f"Hello, {name}! CPU temp check uses hwmon intercept in preview."
