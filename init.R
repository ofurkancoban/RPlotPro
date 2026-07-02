# R Plot Pro Initialization Script
# This script is automatically sourced by the VS Code extension

# Professional Stealth: Mirror Mode (Total Silence)
# All custom header/logo reconstruction has been removed to preserve native aesthetics.


# v0.38.0 Internal Wipe
cat("\r\x1b[A\x1b[K")

local({
    this_version <- "0.48.0"

    # If server is already running at the SAME version, skip re-initialization.
    # This prevents the sentinel (which fires 1-4s after terminal opens) from
    # restarting a healthy server and destroying captured plots.
    # If the extension was updated (version mismatch), stop the old server so
    # the new code takes effect - the user installed a new vsix.
    already_running <- tryCatch(
        exists(".vsc_rplot", envir = .GlobalEnv) && !is.null(.vsc_rplot$server),
        error = function(e) FALSE
    )
    if (already_running) {
        running_version <- tryCatch(.vsc_rplot$version, error = function(e) "")
        if (identical(running_version, this_version)) {
            return(invisible(NULL))   # same version - leave everything intact
        }
        # Different version - stop old server gracefully before re-init
        tryCatch(.vsc_rplot$stop_plot_viewer(), error = function(e) {})
    }

    # Resolve the directory of this script.
    # Priority order:
    #   1. GlobalEnv$script_dir  - set by the Sentinel injection path
    #   2. sys.frame()$ofile     - works when sourced directly (e.g. injection fallback)
    #   3. RPLOT_PRO_INIT env var - set by environmentVariableCollection; used when
    #      R starts via ~/.Rprofile so sys.frame ofile is unavailable
    script_dir <- tryCatch({
        if (exists("script_dir", envir = .GlobalEnv)) {
            get("script_dir", envir = .GlobalEnv)
        } else {
            ofile <- sys.frame(1)$ofile
            if (!is.null(ofile) && nzchar(ofile)) dirname(ofile) else stop("no ofile")
        }
    }, error = function(e) {
        init_path <- Sys.getenv("RPLOT_PRO_INIT")
        if (nzchar(init_path)) dirname(init_path) else getwd()
    })

    # Enable source preservation for better code highlighting
    # options(keep.source = TRUE, keep.source.pkgs = TRUE) # Removed as per cleanup

    # Helper to safely source files
    source_safe <- function(filename) {
        f <- file.path(script_dir, filename)
        if (file.exists(f)) {
            source(f, local = TRUE)
        } else {
            warning(paste("Could not find", filename, "in", script_dir))
        }
    }

    # Redirect all graphics to a null PDF device immediately.
    # options(device=) only affects NEW device openings; if a visible device
    # (quartz / X11 / windows) is already active we must close it first.
    # Plots drawn before injection are rescued from the visible device and
    # replayed onto the null PDF so start_plot_viewer() can capture & send them.
    tryCatch({
        null_device <- function(...) { pdf(file = NULL, ...); dev.control("enable") }
        options(device = null_device)

        # Rescue the last plot from any visible device before closing it.
        # (Only the current display list is recoverable - earlier plots in a
        # multi-plot source() run are gone once overwritten on quartz/X11.)
        rescued_plot <- NULL
        while (dev.cur() > 1) {
            dev_name <- names(dev.cur())
            if (grepl("quartz|X11|windows|JavaGD|RStudioGD", dev_name, ignore.case = TRUE)) {
                rescued_plot <- tryCatch(recordPlot(), error = function(e) NULL)
                dev.off()
            } else {
                break
            }
        }

        # Ensure a null PDF device is active
        if (dev.cur() == 1) null_device()

        # Replay the rescued plot onto the null PDF so start_plot_viewer()
        # finds it when it calls safe_capture(force = TRUE) at startup.
        if (!is.null(rescued_plot)) {
            tryCatch(replayPlot(rescued_plot), error = function(e) {})
        }
    }, error = function(e) {})

    # Source the components
    # Each component will assign its public API to .vsc_rplot
    tryCatch(
        source_safe("plot_server.R"),
        error = function(e) stop(paste("R Plot Pro: failed to load plot_server.R:", e$message))
    )

    # Start the viewer automatically
    # We swallow errors and cleanup GlobalEnv pollution
    tryCatch(
        {
            if (
                exists(".vsc_rplot") &&
                    exists("start_plot_viewer", envir = .vsc_rplot)
            ) {
                .vsc_rplot$start_plot_viewer()
            }
        },
        error = function(e) {}
    )
})
