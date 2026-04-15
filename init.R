# R Plot Pro Initialization Script
# This script is automatically sourced by the VS Code extension

# Professional Stealth: Mirror Mode (Total Silence)
# All custom header/logo reconstruction has been removed to preserve native aesthetics.


# v0.38.0 Internal Wipe
cat("\r\x1b[A\x1b[K")

local({
    # Get the directory of this script
    # Ghost Protocol (v0.28.0): Check if script_dir was passed from GlobalEnv
    if (exists("script_dir", envir = .GlobalEnv)) {
        script_dir <- get("script_dir", envir = .GlobalEnv)
    } else {
        script_dir <- dirname(sys.frame(1)$ofile)
    }

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

    # Source the components
    # Each component will assign its public API to .vsc_rplot
    source_safe("plot_server.R")

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
