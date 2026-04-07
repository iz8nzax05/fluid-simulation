================================================================================
CODE DOCUMENTATION INDEX
================================================================================

This folder contains detailed documentation of the Fluid Particles codebase.

FILES:
------

01_INITIALIZATION_ORDER.txt
  → Shows exact startup sequence
  → What loads when and in what order
  → Critical async loading dependencies

02_FILE_DEPENDENCIES.txt
  → What each file does
  → Which files depend on which
  → Purpose of each component

03_RENDERING_LOOP.txt
  → Frame-by-frame execution order
  → Simulation step details
  → Rendering pipeline details
  → Performance notes

04_EVENT_HANDLING.txt
  → All event handlers
  → Mouse, keyboard, window events
  → UI button and slider events
  → Camera controls

05_CRITICAL_CODE_PATHS.txt
  → Important function call chains
  → Starting/stopping simulation
  → Creating boxes
  → Changing settings

06_TROUBLESHOOTING_GUIDE.txt
  → What to check when things break
  → Common symptoms and fixes
  → Debugging checklist
  → Common mistakes to avoid

HOW TO USE:
-----------
1. Read 01_INITIALIZATION_ORDER.txt first to understand startup
2. Read 02_FILE_DEPENDENCIES.txt to understand architecture
3. Use 03_RENDERING_LOOP.txt when debugging rendering issues
4. Use 04_EVENT_HANDLING.txt when debugging interaction issues
5. Use 05_CRITICAL_CODE_PATHS.txt to trace specific features
6. Use 06_TROUBLESHOOTING_GUIDE.txt when something breaks

WHEN MAKING CHANGES:
--------------------
1. Check relevant documentation file first
2. Understand what calls what
3. Verify dependencies won't break
4. Test after each change
5. Update documentation if you change flow

================================================================================
