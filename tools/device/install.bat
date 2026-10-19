@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem Find Python: "python" on PATH, else the "py" launcher (python.org 3.13+ and the Store build)
set "PY="
python --version >nul 2>&1 && set "PY=python"
if not defined PY (py -3 --version >nul 2>&1 && set "PY=py -3")
if not defined PY (
  echo Python is not installed.
  echo Download this file, run it, and tick "Add python.exe to PATH" at the bottom of the first screen:
  echo https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe
  pause
  exit /b 1
)
echo Using: %PY%

echo [1/3] Installing Python packages...
%PY% -m pip install --upgrade -r requirements.txt
if errorlevel 1 (echo Installing packages failed. Check the internet connection and try again. & pause & exit /b 1)

if not exist config.ini (
  copy config.example.ini config.ini >nul
  echo [!] config.ini was created. Fill it in, save, then run install.bat again.
  notepad config.ini
  pause
  exit /b 1
)

echo [2/3] Test run...
%PY% sync.py
if errorlevel 1 (echo The test run failed. Open sync.log to see why. & pause & exit /b 1)

rem The scheduled task needs the real pythonw.exe path, not a launcher alias
for /f "usebackq delims=" %%P in (`%PY% -c "import sys,os;print(os.path.join(os.path.dirname(sys.executable),'pythonw.exe'))"`) do set "PYW=%%P"
echo [3/3] Scheduling every 5 minutes and at logon, with %PYW%
schtasks /Create /F /TN "Everest Fingerprint Sync" /SC MINUTE /MO 5 /TR "\"%PYW%\" \"%~dp0sync.py\""
schtasks /Create /F /TN "Everest Fingerprint Sync (logon)" /SC ONLOGON /TR "\"%PYW%\" \"%~dp0sync.py\""
echo.
echo Done. The portal shows the device as connected within 5 minutes.
pause
