@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [1/3] Installing Python packages...
python -m pip install --upgrade -r requirements.txt
if errorlevel 1 (echo Python is missing. Install it from python.org and tick "Add python.exe to PATH". & pause & exit /b 1)
if not exist config.ini (
  copy config.example.ini config.ini >nul
  echo [!] config.ini was created. Fill it in, save, then run install.bat again.
  notepad config.ini
  pause
  exit /b 1
)
echo [2/3] Test run...
python sync.py
if errorlevel 1 (echo The test run failed. Open sync.log to see why. & pause & exit /b 1)
for /f "delims=" %%P in ('python -c "import sys,os;print(os.path.join(os.path.dirname(sys.executable),'pythonw.exe'))"') do set "PYW=%%P"
echo [3/3] Scheduling: every 5 minutes, and at logon...
schtasks /Create /F /TN "Everest Fingerprint Sync" /SC MINUTE /MO 5 /TR "\"%PYW%\" \"%~dp0sync.py\""
schtasks /Create /F /TN "Everest Fingerprint Sync (logon)" /SC ONLOGON /TR "\"%PYW%\" \"%~dp0sync.py\""
echo.
echo Done. The portal shows the device as connected within 5 minutes.
pause
