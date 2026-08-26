import serial, time, sys
port = sys.argv[1] if len(sys.argv) > 1 else 'COM7'
secs = float(sys.argv[2]) if len(sys.argv) > 2 else 6.0
p = serial.Serial()
p.port = port
p.baudrate = 115200
p.dtr = False
p.rts = False
p.timeout = 0.2
p.open()
# pulse EN low then release -> reset into run mode, so we catch the boot banner
p.rts = True
time.sleep(0.12)
p.rts = False
deadline = time.time() + secs
while time.time() < deadline:
    line = p.readline()
    if line:
        sys.stdout.write(line.decode('utf-8', 'replace'))
        sys.stdout.flush()
p.close()
