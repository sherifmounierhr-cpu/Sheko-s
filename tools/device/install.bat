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

rem A private Python just for this program, so nothing else on the PC can change it
echo [1/4] Preparing a private Python in .venv ...
if not exist ".venv\Scripts\python.exe" %PY% -m venv .venv
if not exist ".venv\Scripts\python.exe" (echo Could not create .venv. & pause & exit /b 1)
set "VPY=%~dp0.venv\Scripts\python.exe"
set "VPYW=%~dp0.venv\Scripts\pythonw.exe"

rem Exact versions, checked against their published fingerprints (hashes)
echo [2/4] Installing packages (checked against requirements.txt hashes)...
"%VPY%" -m pip install --disable-pip-version-check --require-hashes -r requirements.txt
if errorlevel 1 (echo Installing packages failed. Check the internet connection and try again. & pause & exit /b 1)

if not exist config.ini (
  copy config.example.ini config.ini >nul
  echo [!] config.ini was created. Fill it in, save, then run install.bat again.
  notepad config.ini
  pause
  exit /b 1
)

rem Only this Windows user, SYSTEM and administrators may read or change this folder
rem (config.ini holds the database password)
icacls "%~dp0." /inheritance:r /grant:r "%USERDOMAIN%\%USERNAME%:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" >nul
if errorlevel 1 (echo [!] Could not lock the folder permissions. Continuing.) else (echo Folder locked to %USERNAME%.)

echo [3/4] Test run...
"%VPY%" -I "%~dp0sync.py"
if errorlevel 1 (echo The test run failed. Open sync.log to see why. & pause & exit /b 1)

echo [4/4] Scheduling every 5 minutes
schtasks /Create /F /TN "Everest Fingerprint Sync" /SC MINUTE /MO 5 /TR "\"%VPYW%\" -I \"%~dp0sync.py\""
rem Also run once at sign-in (Startup folder: no admin rights needed)
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
> "%STARTUP%\EverestSync.cmd" echo @start "" "%VPYW%" -I "%~dp0sync.py"
if exist "%STARTUP%\EverestSync.cmd" (echo Added to Startup: runs at sign-in too.)
echo.
echo Done. The portal shows the device as connected within 5 minutes.
pause
