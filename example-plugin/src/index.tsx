import { definePlugin } from "@decky/api";
import { PanelSection, PanelSectionRow, Button, Focusable, TextField } from "@decky/ui";
import { call } from "@decky/api";
import { useState, useEffect } from "react";
import { registerExamplePreviewTestHooks } from "./preview/previewTestHooks";

function MainContent() {
  const [name, setName] = useState("Decky dev");
  const [reply, setReply] = useState("");

  useEffect(() => {
    registerExamplePreviewTestHooks();
  }, []);

  return (
    <PanelSection title="Example Plugin">
      <PanelSectionRow>
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} />
      </PanelSectionRow>
      <PanelSectionRow>
        <Focusable
          onOKButton={async () => {
            const res = (await call("get_greeting", name)) as string;
            setReply(res);
          }}
        >
          <Button onClick={async () => {
            const res = (await call("get_greeting", name)) as string;
            setReply(res);
          }}>Greet</Button>
        </Focusable>
      </PanelSectionRow>
      {reply && <PanelSectionRow>{reply}</PanelSectionRow>}
    </PanelSection>
  );
}

export default definePlugin(() => ({
  name: "Example Plugin",
  content: <MainContent />,
}));
