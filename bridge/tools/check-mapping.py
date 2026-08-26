# Does SDL consider this a MAPPED game controller (known layout, named buttons)
# or just a raw joystick (numbered buttons, no layout)?
# Steam builds on SDL's controller database, so this predicts a lot about S1/S2.
import os
os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
import pygame
from pygame._sdl2 import controller

pygame.init()
pygame.joystick.init()
controller.init()

for i in range(pygame.joystick.get_count()):
    j = pygame.joystick.Joystick(i)
    j.init()
    mapped = controller.is_controller(i)
    print(f"[{i}] {j.get_name()!r}")
    print(f"     guid            : {j.get_guid()}")
    print(f"     SDL game controller mapping: {'YES' if mapped else 'NO — raw joystick'}")
    if mapped:
        c = controller.Controller(i)
        print(f"     mapped name     : {c.name}")
