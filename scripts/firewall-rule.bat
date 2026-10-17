@echo off
setlocal

rem ตรวจสอบสิทธิ์ผู้ดูแลระบบก่อนเพิ่ม Windows Firewall rule
net session >nul 2>&1
if errorlevel 1 (
  echo ต้องรันแบบ Run as Administrator
  pause
  exit /b 1
)

rem เปิด inbound TCP port 3000 ให้เครื่องอื่นในเครือข่ายเข้าถึงได้
echo Adding Windows Firewall rule for TCP port 3000...
netsh advfirewall firewall add rule name="SmartQueue 3000" dir=in action=allow protocol=TCP localport=3000
if errorlevel 1 (
  echo ERROR: เพิ่ม firewall rule ไม่สำเร็จ
  pause
  exit /b 1
)

echo Firewall rule added successfully.
pause
endlocal
