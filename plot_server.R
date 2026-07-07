# R Plot Pro WebSocket Server - Encapsulated

# Create global hidden environment if it doesn't exist
if (!exists(".vsc_rplot", envir = .GlobalEnv)) {
    assign(".vsc_rplot", new.env(parent = .GlobalEnv), envir = .GlobalEnv)
}

local(
    {
        # Gerekli paketleri sessizce yükle (Yansıtıcı Ayna - CRAN Mirror otomasyonu)
        ensure_rplot_pkgs <- function() {
            pkgs <- c("httpuv", "jsonlite", "base64enc", "svglite")
            missing <- pkgs[!vapply(pkgs, requireNamespace, logical(1), quietly = TRUE)]
            
            if (length(missing) > 0) {
                # Ayna seçimi penceresini engelle (Cloud mirror her zaman en güvenlisi)
                repos <- getOption("repos")
                if (is.null(repos) || repos["CRAN"] == "@CRAN@") {
                    repos["CRAN"] <- "https://cloud.r-project.org"
                    options(repos = repos)
                }
                
                # Yazma yetkisi olan bir kütüphane yolu bul veya oluştur (Windows kişisel kütüphane engeli için)
                lib_paths <- .libPaths()
                writable_lib <- NULL
                for (p in lib_paths) {
                    if (file.access(p, 2) == 0) {
                        writable_lib <- p
                        break
                    }
                }
                
                # Eğer hiç yazılabilir kütüphane yoksa, standart kullanıcı kütüphanesini aktive et
                if (is.null(writable_lib)) {
                    user_lib <- Sys.getenv("R_LIBS_USER")
                    if (user_lib != "") {
                        if (!dir.exists(user_lib)) {
                            dir.create(user_lib, recursive = TRUE, showWarnings = FALSE)
                        }
                        .libPaths(c(user_lib, .libPaths()))
                        writable_lib <- user_lib
                    }
                }
                
                # Paketi yükle (lib ve repos vererek soruları bypass ediyoruz)
                install.packages(missing, lib = writable_lib, dependencies = TRUE)
            }
        }
        
        # Sessizce paket kontrolü yap
        suppressMessages(ensure_rplot_pkgs())

        library(httpuv)
        library(jsonlite)
        library(base64enc)
        library(svglite)

        # State variables (now local to this block)
        clients <- list()
        plots <- list() # Stores metadata (id, timestamp, format, etc.)
        raw_plots <- list() # Stores raw bytes by ID
        recordings <- list() # Stores internal recordedPlot objects by ID
        server <- NULL
        last_plot <- NULL
        callback_id <- NULL
        client_dims <- list(width = 800, height = 600)
        in_capture <- FALSE
        last_capture_time <- 0
        throttle_ms <- 500 # Minimum time between captures (interactive use)
        hook_registered <- FALSE # plot.new hook registered once per server lifetime
        hook_active <- FALSE     # enables/disables the hook without removing it
        plot_new_called <- FALSE # TRUE when plot.new() fired during current expression

        # Source provenance of the top-level expression that produced the current
        # plot, captured from the task callback and attached to plot metadata so the
        # webview can offer Copy / Reveal / Run-again / Open-source-file actions.
        last_expr_code <- ""
        last_expr_file <- ""
        last_expr_line1 <- NA_integer_
        last_expr_line2 <- NA_integer_
        # Coordinate transform of the current base-graphics plot (user-space limits and
        # panel position), captured after replay so the webview can map a hovered pixel
        # back to data coordinates. NULL for grid/ggplot/lattice plots.
        last_coords <- NULL
        # Coordinate transform of the most recent resize re-render; forwarded with
        # the update_plot message so hover-inspect stays aligned after a resize.
        resize_coords <- NULL
        # Data points drawn on the current frame (accumulated from graphics::plot.xy in
        # user coordinates), so the webview can snap hover-inspect to the nearest point.
        # Reset on each new frame; capped to keep the payload small.
        pending_x <- numeric(0)
        pending_y <- numeric(0)
        POINTS_CAP <- 5000
        # The ggplot object behind the current frame (stashed by the print.ggplot
        # trace) and per-plot ggplot objects, so hover-inspect coordinates and
        # resize re-renders work for ggplot2 as well as base graphics.
        last_ggplot <- NULL
        last_render_gg <- NULL
        gg_objects <- list()
        # TRUE between a set_last_plot stash and the grid.newpage of the same
        # print; lets newpage tell a ggplot frame from a lattice/raw grid frame.
        gg_stash_fresh <- FALSE
        
        # Debug logging. Use a cross-platform temp path (tempdir()) instead of a
        # hardcoded "/tmp", which does not exist on Windows, and swallow warnings
        # as well as errors so a failed write can never surface in the user's R
        # session (e.g. the "cannot open file '/tmp/rplot_debug.log'" warning).
        debug_log_file <- tryCatch(file.path(tempdir(), "rplot_debug.log"),
                                   error = function(e) "")
        log_debug <- function(msg) {
            if (!nzchar(debug_log_file)) return(invisible(NULL))
            suppressWarnings(tryCatch({
                cat(paste0("[", format(Sys.time(), "%H:%M:%S"), "] ", msg, "\n"),
                    file = debug_log_file, append = TRUE)
            }, error = function(e) NULL))
        }
        log_debug("Plot Server initializing...")

        # Script dizinini bul
        script_dir <- getwd()
        tryCatch(
            {
                if (!is.null(sys.frame(1)$ofile)) {
                    script_dir <- dirname(sys.frame(1)$ofile)
                }
            },
            error = function(e) {}
        )

        # Process resize request
        handle_resize_request <- function(width, height, plot_id = NULL) {
            if (is.null(plot_id) || !startsWith(as.character(plot_id), "r-")) {
                return(NULL)
            }
            
            pid <- as.character(plot_id)
            if (is.null(recordings[[pid]])) {
                for (p in plots) {
                    if (as.character(p$id) == pid) {
                        pid <- as.character(p$id)
                        break
                    }
                }
            }
            
            target_plot <- if (!is.null(recordings[[pid]])) recordings[[pid]] else last_plot
            
            if (!is.null(target_plot)) {
                capture_and_send(target_plot, width, height, update_id = pid)
            }
        }

        # Capture and send to webview
        # Device size (in inches at 96 dpi) matching the viewer panel, so the very
        # first render already fits the canvas instead of a fixed 10x6 that only
        # gets corrected by the next resize round-trip. client_dims is refreshed
        # by the webview on connect and on every layout change.
        device_dims_in <- function() {
            list(
                width  = max(client_dims$width, 50) / 96,
                height = max(client_dims$height, 50) / 96
            )
        }

        capture_and_send <- function(target_plot, width, height, update_id = NULL) {
            if (is.null(target_plot)) return(NULL)
            width_in <- max(width, 50) / 96
            height_in <- max(height, 50) / 96

            tryCatch(
                {
                    temp_file <- tempfile(fileext = ".svg")
                    # Guard against re-entry: re-printing a ggplot fires the
                    # print.ggplot trace, whose capture call must be a no-op here.
                    was_in_capture <- in_capture
                    in_capture <<- TRUE
                    on.exit(in_capture <<- was_in_capture, add = TRUE)
                    gg_obj <- if (!is.null(update_id)) gg_objects[[as.character(update_id)]] else NULL
                    svglite::svglite(filename = temp_file, width = width_in, height = height_in, bg = "white")
                    drew_gg <- FALSE
                    if (!is.null(gg_obj)) {
                        drew_gg <- tryCatch({ print(gg_obj); TRUE }, error = function(e) FALSE)
                    }
                    if (!drew_gg) replayPlot(target_plot)
                    # Panel fractions (plt) depend on device size, so re-read the
                    # coordinate transform for the resized render and let the ws
                    # handler forward it with the update_plot message.
                    resize_coords <<- read_plot_coords()
                    if (is.null(resize_coords) && drew_gg) {
                        info <- read_gg_coords(gg_obj)
                        if (!is.null(info)) resize_coords <<- info$coords
                    }
                    dev.off()

                    if (file.exists(temp_file)) {
                        readBin(temp_file, "raw", file.info(temp_file)$size)
                    } else NULL
                },
                error = function(e) NULL,
                finally = { if (exists("temp_file") && file.exists(temp_file)) unlink(temp_file) }
            )
        }

        # WebSocket handler
        plot_ws_handler <- function(ws) {
            client_id <- as.character(runif(1))
            ws$onMessage(function(binary, message) {
                tryCatch({
                    data <- fromJSON(message)
                    if (data$type == "ping") {
                        ws$send(toJSON(list(type = "pong")))
                    } else if (data$type == "get_plots") {
                        ws$send(toJSON(list(type = "plot_list", plots = plots), auto_unbox = TRUE))
                    } else if (data$type == "request_binary") {
                        pid <- as.character(data$plot_id)
                        if (!is.null(raw_plots[[pid]])) {
                            fmt <- "svg" 
                            for (p in plots) if (as.character(p$id) == pid) { fmt <- p$format; break }
                            send_binary_to_client(ws, "update_plot", raw_plots[[pid]], list(id = pid, format = fmt))
                        }
                    } else if (data$type == "delete_plot") {
                        pid <- as.character(data$plot_id)
                        recordings[[pid]] <<- NULL
                        raw_plots[[pid]] <<- NULL
                        gg_objects[[pid]] <<- NULL
                        plots <<- Filter(function(x) as.character(x$id) != pid, plots)
                        msg <- toJSON(list(type = "plot_list", plots = plots), auto_unbox = TRUE)
                        for (c in clients) tryCatch(c$send(msg), error = function(e) {})
                    } else if (data$type == "resize") {
                        client_dims$width <<- as.integer(data$width)
                        client_dims$height <<- as.integer(data$height)
                        raw_data <- handle_resize_request(client_dims$width, client_dims$height, data$plot_id)
                        if (!is.null(raw_data)) {
                            pid <- if (!is.null(data$plot_id)) as.character(data$plot_id) else if (length(plots) > 0) plots[[length(plots)]]$id else NULL
                            if (!is.null(pid)) {
                                fmt <- "svg"
                                for (p in plots) if (as.character(p$id) == pid) { fmt <- p$format; break }
                                meta <- list(id = pid, format = fmt)
                                if (!is.null(resize_coords)) meta$coords <- resize_coords
                                send_binary_to_client(ws, "update_plot", raw_data, meta)
                            }
                        }
                    }
                }, error = function(e) {})
            })
            ws$onClose(function() { clients[[client_id]] <<- NULL })
            clients[[client_id]] <<- ws
            if (length(plots) > 0) ws$send(toJSON(list(type = "plot_list", plots = plots), auto_unbox = TRUE))
        }

        # HTTP handler
        plot_http_handler <- function(req) {
            if (req$PATH_INFO == "/") {
                html_file <- file.path(script_dir, "plot_viewer.html")
                if (!file.exists(html_file)) html_file <- "plot_viewer.html"
                if (file.exists(html_file)) {
                    list(status = 200L, headers = list("Content-Type" = "text/html"), body = paste(readLines(html_file, warn = FALSE), collapse = "\n"))
                } else list(status = 404L, headers = list("Content-Type" = "text/plain"), body = "Not found")
            } else list(status = 404L, headers = list("Content-Type" = "text/plain"), body = "Not found")
        }

        send_binary_to_client <- function(client_ws, type, bin_payload, metadata = list()) {
            metadata$type <- type
            meta_json <- toJSON(metadata, auto_unbox = TRUE)
            meta_bytes <- charToRaw(meta_json)
            meta_len <- length(meta_bytes)
            con <- rawConnection(raw(0), "wb")
            writeBin(as.integer(meta_len), con, size = 4, endian = "big")
            writeBin(meta_bytes, con)
            writeBin(bin_payload, con)
            full_frame <- rawConnectionValue(con)
            close(con)
            tryCatch(client_ws$send(full_frame), error = function(e) {})
        }

        send_plot_to_clients <- function(raw_data, metadata = list()) {
            for (client in clients) send_binary_to_client(client, "new_plot", raw_data, metadata)
        }

        # Build plot metadata, attaching captured source provenance when available.
        make_meta <- function(id) {
            m <- list(id = id, timestamp = format(Sys.time(), "%H:%M:%S"), format = "svg")
            if (nzchar(last_expr_code)) m$code <- last_expr_code
            if (nzchar(last_expr_file)) m$srcFile <- last_expr_file
            if (!is.na(last_expr_line1)) m$srcLine1 <- last_expr_line1
            if (!is.na(last_expr_line2)) m$srcLine2 <- last_expr_line2
            if (!is.null(last_coords)) m$coords <- last_coords
            # Attach plotted points for hover-snapping, only for base plots with a valid
            # coordinate system and a manageable number of points.
            if (!is.null(last_coords) && length(pending_x) > 0) {
                keep <- is.finite(pending_x) & is.finite(pending_y)
                # I() keeps single-point vectors serialized as JSON arrays even
                # with auto_unbox = TRUE, so the webview always receives arrays.
                if (any(keep)) {
                    m$points <- list(x = I(pending_x[keep]), y = I(pending_y[keep]))
                }
            }
            m
        }

        # Read the current device's base-graphics coordinate system. Must be called
        # while the (svglite) device is still open, right after replayPlot. Returns NULL
        # for grid-based plots (ggplot2/lattice), which leave par("usr") at its default.
        read_plot_coords <- function() {
            tryCatch({
                usr <- graphics::par("usr")
                plt <- graphics::par("plt")
                if (isTRUE(all.equal(as.numeric(usr), c(0, 1, 0, 1)))) return(NULL)
                list(
                    usr  = as.numeric(usr),
                    plt  = as.numeric(plt),
                    xlog = isTRUE(graphics::par("xlog")),
                    ylog = isTRUE(graphics::par("ylog"))
                )
            }, error = function(e) NULL)
        }

        # Coordinate system + plotted points of a single-panel Cartesian ggplot.
        # Must run while the device the plot was just printed on is still open,
        # because the panel position comes from the live grid viewport tree.
        # Returns list(coords, points) in the same shape as base graphics, or NULL
        # (facets, non-Cartesian coords, or any failure fall back gracefully).
        read_gg_coords <- function(gg) {
            tryCatch({
                if (!requireNamespace("ggplot2", quietly = TRUE)) return(NULL)
                if (!identical(class(gg$coordinates)[1], "CoordCartesian")) return(NULL)
                b <- ggplot2::ggplot_build(gg)
                if (length(b$layout$panel_params) != 1) return(NULL)
                pp <- b$layout$panel_params[[1]]
                xr <- suppressWarnings(as.numeric(pp$x.range))
                yr <- suppressWarnings(as.numeric(pp$y.range))
                if (length(xr) != 2 || length(yr) != 2 || any(!is.finite(c(xr, yr)))) return(NULL)

                # Panel position on the device, as figure fractions (like par("plt")).
                s <- paste(utils::capture.output(print(grid::current.vpTree())), collapse = " ")
                panels <- unique(regmatches(s, gregexpr("panel\\.[0-9]+-[0-9]+-[0-9]+-[0-9]+", s))[[1]])
                if (length(panels) != 1) return(NULL)
                grid::seekViewport(panels[1])
                lo <- grid::deviceLoc(grid::unit(0, "npc"), grid::unit(0, "npc"), valueOnly = TRUE)
                hi <- grid::deviceLoc(grid::unit(1, "npc"), grid::unit(1, "npc"), valueOnly = TRUE)
                grid::upViewport(0)
                din <- graphics::par("din")
                if (any(!is.finite(c(lo$x, lo$y, hi$x, hi$y))) || any(din <= 0)) return(NULL)

                # Ranges are in transformed space for log scales, matching par("usr").
                trans_name <- function(sc) {
                    tryCatch(sc$trans$name, error = function(e)
                        tryCatch(sc$get_transformation()$name, error = function(e2) ""))
                }
                xlog <- identical(trans_name(b$layout$panel_scales_x[[1]]), "log-10")
                ylog <- identical(trans_name(b$layout$panel_scales_y[[1]]), "log-10")
                coords <- list(
                    usr = c(xr, yr),
                    plt = c(lo$x / din[1], hi$x / din[1], lo$y / din[2], hi$y / din[2]),
                    xlog = xlog, ylog = ylog,
                    gg = TRUE
                )

                # Layer data for hover-snapping; back-transform log values so the
                # webview (which log10s when xlog/ylog) receives raw data space.
                px <- numeric(0); py <- numeric(0)
                for (d in b$data) {
                    if (is.data.frame(d) && all(c("x", "y") %in% names(d))) {
                        dx <- suppressWarnings(as.numeric(d$x))
                        dy <- suppressWarnings(as.numeric(d$y))
                        if (xlog) dx <- 10^dx
                        if (ylog) dy <- 10^dy
                        px <- c(px, dx); py <- c(py, dy)
                        if (length(px) >= POINTS_CAP) break
                    }
                }
                keep <- is.finite(px) & is.finite(py)
                pts <- if (any(keep)) {
                    list(x = utils::head(px[keep], POINTS_CAP), y = utils::head(py[keep], POINTS_CAP))
                } else NULL
                list(coords = coords, points = pts)
            }, error = function(e) NULL)
        }

        # Draw the current frame on the open capture device. ggplot frames are
        # re-printed from the stashed object (replayPlot draws them fine but the
        # grid viewports needed for panel geometry are not queryable afterwards);
        # everything else replays the recording. Refreshes last_coords and, for
        # ggplot, the snap-point buffer.
        render_frame <- function(current_plot) {
            gg <- last_ggplot
            drew_gg <- FALSE
            if (!is.null(gg)) {
                drew_gg <- tryCatch({ print(gg); TRUE }, error = function(e) FALSE)
            }
            if (!drew_gg) replayPlot(current_plot)
            last_render_gg <<- if (drew_gg) gg else NULL
            last_coords <<- read_plot_coords()
            if (is.null(last_coords) && drew_gg) {
                info <- read_gg_coords(gg)
                if (!is.null(info)) {
                    last_coords <<- info$coords
                    if (!is.null(info$points)) {
                        pending_x <<- info$points$x
                        pending_y <<- info$points$y
                    } else {
                        pending_x <<- numeric(0)
                        pending_y <<- numeric(0)
                    }
                }
            }
            invisible(drew_gg)
        }

        process_internal_capture <- function(current_plot, temp_file_path = NULL,
                                             bypass_throttle = FALSE, update_last = FALSE) {
            if (is.null(current_plot)) return()
            now <- as.numeric(Sys.time()) * 1000
            if (!bypass_throttle && now - last_capture_time < throttle_ms) return()

            if (!identical(current_plot, last_plot)) {
                last_plot <<- current_plot
                last_capture_time <<- now

                if (is.null(temp_file_path)) {
                    temp_file <- tempfile(fileext = ".svg")
                    dims <- device_dims_in()
                    # Guard against re-entry: re-printing a ggplot fires the
                    # print.ggplot trace, whose capture call must be a no-op here.
                    was_in_capture <- in_capture
                    in_capture <<- TRUE
                    svglite::svglite(filename = temp_file, width = dims$width, height = dims$height, bg = "white")
                    render_frame(current_plot)
                    dev.off()
                    in_capture <<- was_in_capture
                } else temp_file <- temp_file_path

                if (file.exists(temp_file)) {
                    fsize <- file.size(temp_file)
                    if (fsize < 400) { unlink(temp_file); return() }

                    raw_data <- readBin(temp_file, "raw", fsize)

                    # update_last=TRUE: expression didn't open a new frame (e.g. qqline,
                    # lines, points) - replace the last entry instead of adding a new one.
                    if (update_last && length(plots) > 0) {
                        id <- plots[[length(plots)]]$id
                        plot_metadata <- make_meta(id)
                        plots[[length(plots)]] <<- plot_metadata
                        recordings[[id]] <<- current_plot
                        raw_plots[[id]] <<- raw_data
                        for (client in clients)
                            send_binary_to_client(client, "update_plot", raw_data, plot_metadata)
                    } else {
                        id <- sprintf("r-%.0f", as.numeric(Sys.time()) * 1000)
                        plot_metadata <- make_meta(id)

                        if (length(plots) >= 200) {
                            old_id <- plots[[1]]$id
                            recordings[[old_id]] <<- NULL
                            raw_plots[[old_id]] <<- NULL
                            gg_objects[[old_id]] <<- NULL
                            plots <<- plots[-1]
                        }

                        plots[[length(plots) + 1]] <<- plot_metadata
                        recordings[[id]] <<- current_plot
                        raw_plots[[id]] <<- raw_data
                        if (!is.null(last_render_gg)) gg_objects[[id]] <<- last_render_gg
                        send_plot_to_clients(raw_data, plot_metadata)
                    }
                    unlink(temp_file)
                }
            }
        }

        # Manual capture helper
        .vsc_rplot$capture <- function() {
            log_debug("Manual capture requested")
            safe_capture(force = TRUE)
        }

        # Called by trace("plot.new") - just sets the flag, no capture.
        # This tells source_capture / check_for_new_plot that a new frame opened.
        # A new frame also starts a fresh point buffer for hover-snapping.
        .vsc_rplot$on_plot_new <- function() {
            plot_new_called <<- TRUE
            pending_x <<- numeric(0)
            pending_y <<- numeric(0)
            # A base-graphics frame invalidates any stashed ggplot object.
            last_ggplot <<- NULL
        }

        # Called by trace("set_last_plot") during ggplot printing (and by the
        # legacy print.ggplot trace on ggplot2 3.x) - stash the plot object so
        # the capture pipeline can re-print it and read its panel geometry
        # (replayPlot leaves no grid viewport tree to query).
        .vsc_rplot$on_ggplot <- function(p) {
            tryCatch({
                last_ggplot <<- p
                gg_stash_fresh <<- TRUE
            }, error = function(e) NULL)
        }

        # Called by trace("grid.newpage") - the grid equivalent of plot.new.
        # Marks a new frame (so consecutive grid plots become separate gallery
        # entries) and invalidates the stashed ggplot: if the frame really is a
        # ggplot, set_last_plot re-stashes it right after this fires; a lattice
        # or raw grid frame leaves it NULL. Our own capture re-renders also fire
        # grid.newpage, hence the in_capture guard.
        .vsc_rplot$on_grid_newpage <- function() {
            if (isTRUE(in_capture)) return(invisible())
            plot_new_called <<- TRUE
            pending_x <<- numeric(0)
            pending_y <<- numeric(0)
            # set_last_plot fires BEFORE grid.newpage inside a ggplot print, so a
            # fresh stash belongs to this very frame - keep it. Without a fresh
            # stash this is a lattice / raw grid frame - drop any stale ggplot.
            if (isTRUE(gg_stash_fresh)) {
                gg_stash_fresh <<- FALSE
            } else {
                last_ggplot <<- NULL
            }
        }

        # Called by trace("plot.xy") - accumulate the plotted data points (user coords).
        .vsc_rplot$on_plot_xy <- function(xy) {
            tryCatch({
                if (length(pending_x) >= POINTS_CAP) return(invisible())
                x <- suppressWarnings(as.numeric(xy$x))
                y <- suppressWarnings(as.numeric(xy$y))
                n <- min(length(x), length(y))
                if (n > 0) {
                    # Truncate to the cap instead of letting one oversized draw
                    # overshoot it, which would drop the point set entirely.
                    pending_x <<- utils::head(c(pending_x, x[seq_len(n)]), POINTS_CAP)
                    pending_y <<- utils::head(c(pending_y, y[seq_len(n)]), POINTS_CAP)
                }
            }, error = function(e) NULL)
        }

        # Legacy entry point kept for safety (no longer used by any tracer).
        .vsc_rplot$safe_capture_batch <- function() {
            if (!isTRUE(hook_active) || isTRUE(in_capture) || dev.cur() <= 1) return()
            safe_capture(bypass_throttle = TRUE)
        }
        
        # Robust capture logic
        safe_capture <- function(force = FALSE, bypass_throttle = FALSE, update_last = FALSE) {
            if (isTRUE(in_capture)) return()
            if (dev.cur() <= 1) return()

            tryCatch({
                current_plot <- recordPlot()
                if (is.null(current_plot)) return()

                if (force || !identical(current_plot, last_plot)) {
                    if (!force && !bypass_throttle) {
                        now <- as.numeric(Sys.time()) * 1000
                        if (now - last_capture_time < throttle_ms) return()
                    }

                    in_capture <<- TRUE
                    on.exit(in_capture <<- FALSE)

                    temp_file <- tempfile(fileext = ".svg")
                    dims <- device_dims_in()
                    svglite::svglite(filename = temp_file, width = dims$width, height = dims$height, bg = "white")
                    render_frame(current_plot)
                    dev.off()

                    process_internal_capture(current_plot, temp_file_path = temp_file,
                                             bypass_throttle = bypass_throttle || force,
                                             update_last = update_last)
                }
            }, error = function(e) { log_debug(paste("Capture Error:", e$message)) })
        }
        
        check_for_new_plot <- function(expr, value, ok, visible) {
            # Capture the code + source location of the expression that just ran, so
            # it can be attached to any plot this expression produces.
            tryCatch({
                last_expr_code <<- paste(deparse(expr), collapse = "\n")
                last_expr_file <<- ""
                last_expr_line1 <<- NA_integer_
                last_expr_line2 <<- NA_integer_
                sref <- attr(expr, "srcref")
                if (!is.null(sref)) {
                    srcfile <- attr(sref, "srcfile")
                    if (!is.null(srcfile) && !is.null(srcfile$filename) && nzchar(srcfile$filename)) {
                        last_expr_file <<- normalizePath(srcfile$filename, mustWork = FALSE)
                    }
                    loc <- as.integer(sref)
                    if (length(loc) >= 3) {
                        last_expr_line1 <<- loc[1]
                        last_expr_line2 <<- loc[3]
                    }
                }
            }, error = function(e) {})

            new_frame <- isTRUE(plot_new_called)
            plot_new_called <<- FALSE
            safe_capture(bypass_throttle = TRUE,
                         update_last = !new_frame && length(plots) > 0)
            return(TRUE)
        }

        vscode_bg_device <- function(...) {
            tryCatch({
                pdf(file = NULL, ...)
                dev.control("enable")
            }, error = function(e) { log_debug(paste("Device Error:", e$message)) })
        }
        
        # Mask standard device functions to force ours
        .vsc_rplot$quartz <- vscode_bg_device
        .vsc_rplot$dev.new <- vscode_bg_device
        .vsc_rplot$x11 <- vscode_bg_device

        # Public functions assigned to .vsc_rplot
        .vsc_rplot$start_plot_viewer <- function(port = NULL) {
            # If server is already running (e.g. started by .Rprofile before the
            # sentinel injection fires), do not restart - just re-enable hooks.
            # This prevents the sentinel from destroying captured plots by
            # restarting a perfectly healthy server.
            if (!is.null(server)) {
                hook_active <<- TRUE
                return(invisible(server))
            }
            # Port range is configurable via the extension (rPlotViewer.minPort/maxPort).
            port_min <- suppressWarnings(as.integer(Sys.getenv("RPLOT_PORT_MIN", "10000")))
            port_max <- suppressWarnings(as.integer(Sys.getenv("RPLOT_PORT_MAX", "30000")))
            if (is.na(port_min) || is.na(port_max) || port_max <= port_min) {
                port_min <- 10000L; port_max <- 30000L
            }
            if (is.null(port)) port <- sample(port_min:port_max, 1)

            env_config_path <- Sys.getenv("VSCODE_R_PLOT_CONFIG")
            local_config_file <- if (nzchar(env_config_path)) {
                if (isTRUE(file.info(env_config_path)$isdir)) file.path(env_config_path, paste0("port_", port, ".json")) else env_config_path
            } else file.path(getwd(), ".r_plot_config.json")

            writeLines(jsonlite::toJSON(list(port = port, language = "r", version = "0.50.0"), auto_unbox = TRUE), local_config_file)

            reg.finalizer(.GlobalEnv, function(e) { if (file.exists(local_config_file)) unlink(local_config_file) }, onexit = TRUE)

            tryCatch({
                server <<- startServer(host = "127.0.0.1", port = port, app = list(call = plot_http_handler, onWSOpen = plot_ws_handler))
            }, error = function(e) {
                if (grepl("address already in use", e$message, ignore.case = TRUE)) {
                    # On Unix, free the port with lsof/kill (these do not exist on
                    # Windows, so guard the call). If the port is still busy - or on
                    # Windows, where we do not force-kill - fall back to a fresh
                    # random port and rewrite the config so the extension connects
                    # to the new one.
                    if (.Platform$OS.type == "unix") {
                        system(sprintf("lsof -ti:%d | xargs kill -9", port), ignore.stderr = TRUE)
                        Sys.sleep(1)
                        server <<- tryCatch(
                            startServer(host = "127.0.0.1", port = port, app = list(call = plot_http_handler, onWSOpen = plot_ws_handler)),
                            error = function(e2) NULL)
                    }
                    if (is.null(server)) {
                        port <<- sample(port_min:port_max, 1)
                        writeLines(jsonlite::toJSON(list(port = port, language = "r", version = "0.50.0"), auto_unbox = TRUE), local_config_file)
                        server <<- startServer(host = "127.0.0.1", port = port, app = list(call = plot_http_handler, onWSOpen = plot_ws_handler))
                    }
                } else stop(e)
            })

            if (is.null(server)) return(invisible(NULL))

            options(device = vscode_bg_device)

            if (!is.null(callback_id)) removeTaskCallback(callback_id)
            callback_id <<- addTaskCallback(check_for_new_plot, name = "plot_viewer_watcher")

            hook_active <<- TRUE

            if (!isTRUE(hook_registered)) {
                tryCatch({
                    suppressMessages({
                        # Flag-only tracer: sets plot_new_called so source_capture /
                        # check_for_new_plot can distinguish "new frame" from "added to
                        # existing frame" (lines, qqline, legend, etc.). No capture here -
                        # that avoids intermediate multi-panel frames (pairs, mfrow).
                        trace("plot.new",
                              tracer = quote(.vsc_rplot$on_plot_new()),
                              print = FALSE,
                              where = asNamespace("graphics"))
                    })
                    hook_registered <<- TRUE
                }, error = function(e) { log_debug(paste("plot.new trace failed:", e$message)) })

                tryCatch({
                    # Capture plotted data points (all base scatter/line drawing funnels
                    # through plot.xy) for hover-snapping. Tracer runs in plot.xy's frame,
                    # so 'xy' (list with x,y in user coords) is in scope.
                    suppressMessages({
                        trace("plot.xy",
                              tracer = quote(.vsc_rplot$on_plot_xy(xy)),
                              print = FALSE,
                              where = asNamespace("graphics"))
                    })
                }, error = function(e) { log_debug(paste("plot.xy trace failed:", e$message)) })

                # grid.newpage is the plot.new of grid graphics (ggplot2, lattice):
                # it separates consecutive grid frames into distinct gallery entries.
                tryCatch({
                    suppressMessages(trace("grid.newpage",
                        tracer = quote(.vsc_rplot$on_grid_newpage()),
                        print = FALSE,
                        where = asNamespace("grid")))
                }, error = function(e) { log_debug(paste("grid.newpage trace failed:", e$message)) })

                # ggplot2 hooks. set_last_plot fires while a ggplot prints on any
                # ggplot2 version (including 4.x, where print.ggplot no longer
                # exists as an S3 method); print.ggplot is kept for 3.x where its
                # exit hook captures immediately. Registered now if ggplot2 is
                # installed, and again via onLoad if it loads later.
                .vsc_rplot$register_gg_traces <- function() {
                    tryCatch({
                        if (!requireNamespace("ggplot2", quietly = TRUE)) return(invisible())
                        ns <- asNamespace("ggplot2")
                        if (exists("set_last_plot", envir = ns)) {
                            suppressMessages(trace("set_last_plot",
                                tracer = quote(.vsc_rplot$on_ggplot(value)),
                                print = FALSE,
                                where = ns))
                        }
                        if (exists("print.ggplot", envir = ns)) {
                            suppressMessages(trace("print.ggplot", print = FALSE,
                                exit = quote({
                                    options(device = .vsc_rplot$vscode_bg_device)
                                    .vsc_rplot$capture()
                                }),
                                where = ns))
                        }
                    }, error = function(e) { log_debug(paste("ggplot2 trace failed:", e$message)) })
                }
                if (requireNamespace("ggplot2", quietly = TRUE)) {
                    .vsc_rplot$register_gg_traces()
                } else {
                    setHook(packageEvent("ggplot2", "onLoad"),
                            function(...) tryCatch(.vsc_rplot$register_gg_traces(),
                                                   error = function(e) {}))
                }
            }

            # Patch source() in GlobalEnv for reliable per-expression capture
            tryCatch(.vsc_rplot$install_source_patch(), error = function(e) {})

            # Capture any plot that was already on the device when init.R ran
            # (e.g. user sourced a script before injection; init.R rescued it
            # from quartz/X11 and replayed onto the null PDF). Force=TRUE because
            # last_plot is NULL at this point and recordPlot() may return the
            # replayed state.
            tryCatch({
                if (dev.cur() > 1) safe_capture(force = TRUE)
            }, error = function(e) {})

            invisible(server)
        }

        .vsc_rplot$stop_plot_viewer <- function() {
            hook_active <<- FALSE
            # Restore original source() if we patched it
            tryCatch({
                if (exists("source", envir = .GlobalEnv)) rm("source", envir = .GlobalEnv)
            }, error = function(e) {})
            if (!is.null(server)) { stopServer(server); server <<- NULL }
            if (!is.null(callback_id)) { removeTaskCallback(callback_id); callback_id <<- NULL }
            tryCatch(suppressMessages(untrace("plot.new", where = asNamespace("graphics"))),
                     error = function(e) {})
            tryCatch(suppressMessages(untrace("plot.xy", where = asNamespace("graphics"))),
                     error = function(e) {})
            tryCatch(suppressMessages(untrace("grid.newpage", where = asNamespace("grid"))),
                     error = function(e) {})
            tryCatch({
                if (requireNamespace("ggplot2", quietly = TRUE)) {
                    suppressMessages(untrace("set_last_plot", where = asNamespace("ggplot2")))
                }
            }, error = function(e) {})
            tryCatch({
                if (requireNamespace("ggplot2", quietly = TRUE)) {
                    suppressMessages(untrace("print.ggplot", where = asNamespace("ggplot2")))
                }
            }, error = function(e) {})
            hook_registered <<- FALSE
        }

        .vsc_rplot$clear_plots <- function() {
            plots <<- list()
            recordings <<- list()
            gg_objects <<- list()
            last_plot <<- NULL
            msg <- toJSON(list(type = "clear_plots"), auto_unbox = TRUE)
            for (c in clients) tryCatch(c$send(msg), error = function(e) {})
        }

        .vsc_rplot$version  <- "0.50.0"
        .vsc_rplot$run_file <- function(file_path) { utils::source(file_path); invisible(NULL) }

        # Direct capture exposed for patched source() - bypasses hook_active so
        # it works even during .Rprofile startup before the flag is confirmed set.
        .vsc_rplot$source_capture <- function() {
            if (isTRUE(in_capture) || dev.cur() <= 1) return()
            new_frame <- isTRUE(plot_new_called)
            plot_new_called <<- FALSE
            tryCatch(safe_capture(bypass_throttle = TRUE,
                                  update_last = !new_frame && length(plots) > 0),
                     error = function(e) {})
        }

        # Patch source() in GlobalEnv so every top-level expression is followed
        # by a capture attempt. Each expression is evaluated individually so we
        # can probe the device state between calls - the same technique Positron
        # uses in its execution loop.
        .vsc_rplot$install_source_patch <- function() {
            patched <- function(file, local = FALSE, echo = FALSE,
                                print.eval = echo, ...) {
                # Delegate non-file or unparseable calls to the real source()
                if (!is.character(file) || length(file) != 1L) {
                    return(base::source(file, local = local, echo = echo,
                                        print.eval = print.eval, ...))
                }
                expanded <- tryCatch(path.expand(file), error = function(e) file)
                exprs <- tryCatch(parse(expanded), error = function(e) NULL)
                if (is.null(exprs) || length(exprs) == 0L) {
                    return(base::source(file, local = local, echo = echo,
                                        print.eval = print.eval, ...))
                }

                env <- if (isTRUE(local)) new.env(parent = parent.frame()) else .GlobalEnv

                for (i in seq_along(exprs)) {
                    tryCatch(
                        withCallingHandlers(
                            {
                                res <- withVisible(eval(exprs[[i]], envir = env))
                                if (print.eval && res$visible) print(res$value)
                            },
                            message = function(m) {
                                message(conditionMessage(m))
                                invokeRestart("muffleMessage")
                            }
                        ),
                        error = function(e) {
                            cat("Error in", deparse(exprs[[i]]),
                                ":", conditionMessage(e), "\n")
                        }
                    )
                    tryCatch(.vsc_rplot$source_capture(), error = function(e) {})
                }
                invisible(env)
            }
            assign("source", patched, envir = .GlobalEnv)
        }
    },
    envir = .vsc_rplot
)
