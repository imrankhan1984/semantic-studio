@echo off
rem ================================================================================
rem FILE: release/Start Semantic Studio.cmd
rem ================================================================================
rem
rem SUMMARY
rem     The one file a person opens in the Windows release (release-packaging
rem     5.2, D-119): it starts Semantic Studio with the Python bundled beside it.
rem
rem BASIC IDEA
rem     Runs python\python.exe -B -m app.launcher from the folder this file is
rem     in, wherever that is and whatever the path holds: %~dp0 is that folder,
rem     always ending in a backslash, and every use of it is quoted. -B writes
rem     no bytecode, so the release never writes inside its own folder. The
rem     launcher chooses the port, binds 127.0.0.1 and opens the browser;
rem     closing this window stops it. Arguments are passed on (the smoke test
rem     passes --no-browser).
rem
rem INPUTS / INPUT SOURCES
rem     - python\ and app\ beside this file.
rem
rem EXPECTED OUTPUT
rem     - The launcher running in this console window; its exit code.
rem ================================================================================
setlocal
title Semantic Studio
cd /d "%~dp0"
"%~dp0python\python.exe" -B -m app.launcher %*
exit /b %errorlevel%
