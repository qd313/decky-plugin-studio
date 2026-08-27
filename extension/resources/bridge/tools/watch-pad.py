# Watch every joystick SDL can see and report hat/button activity.
# SDL is the same layer Steam reads controllers through, so what shows up
# here is a good proxy for what Steam will see.
import os, sys, time
os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
os.environ.setdefault("SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS", "1")
import pygame

secs = float(sys.argv[1]) if len(sys.argv) > 1 else 11.0

pygame.init()
pygame.joystick.init()
count = pygame.joystick.get_count()
print(f"SDL sees {count} joystick(s)\n")

sticks = []
for i in range(count):
    j = pygame.joystick.Joystick(i)
    j.init()
    sticks.append(j)
    print(f"  [{i}] {j.get_name()!r}")
    print(f"       guid={j.get_guid()}  buttons={j.get_numbuttons()} "
          f"hats={j.get_numhats()} axes={j.get_numaxes()}")

if not sticks:
    print("no joysticks — is the native USB port plugged in?")
    sys.exit(1)

print(f"\nwatching {secs:.0f}s for input ...\n")
last = {}
events = 0
deadline = time.time() + secs
while time.time() < deadline:
    pygame.event.pump()
    for i, j in enumerate(sticks):
        hats = tuple(j.get_hat(h) for h in range(j.get_numhats()))
        btns = tuple(j.get_button(b) for b in range(j.get_numbuttons()))
        state = (hats, btns)
        if i in last and state != last[i]:
            t = f"{time.time() % 1000:8.3f}"
            pressed = [str(b) for b, v in enumerate(btns) if v]
            print(f"[{t}] stick {i} hat={hats} buttons={pressed or '-'}")
            events += 1
        last[i] = state
    time.sleep(0.005)

print(f"\n{events} state change(s) observed")
