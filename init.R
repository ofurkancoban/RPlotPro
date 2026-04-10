# R Plot Pro Initialization Script
# This script is automatically sourced by the VS Code extension

# Professional Stealth: Minimal footprint with wrap-awareness
if (interactive()) {
    len <- as.integer(Sys.getenv("VSC_R_PLOT_LEN", "0"))
    if (is.finite(len) && len > 0) {
        # Calculate exactly how many lines the command occupied
        w <- getOption("width")
        # ceiling(total characters / width) = number of lines
        # We add a +2 safety margin to handle prompt variability and wrapping edge cases
        lines <- ceiling(len / w) + 2
        # Clear lines surgically
        cat(rep("\x1b[A\x1b[2K", lines), "\r", sep = "")
        flush.console()
    } else {
        # Fallback for old terminals
        cat(rep("\x1b[A\x1b[2K", 3), "\r", sep = "")
        flush.console()
    }
}

local({
    # Get the directory of this script
    script_dir <- dirname(sys.frame(1)$ofile)

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
