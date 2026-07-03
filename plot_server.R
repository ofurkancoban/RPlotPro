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
        capture_and_send <- function(target_plot, width, height, update_id = NULL) {
            if (is.null(target_plot)) return(NULL)
            width_in <- max(width, 50) / 96
            height_in <- max(height, 50) / 96

            tryCatch(
                {
                    temp_file <- tempfile(fileext = ".svg")
                    svglite::svglite(filename = temp_file, width = width_in, height = height_in, bg = "white")
                    replayPlot(target_plot)
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
                                send_binary_to_client(ws, "update_plot", raw_data, list(id = pid, format = fmt))
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
            m
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
                    svglite::svglite(filename = temp_file, width = 10, height = 6, bg = "white")
                    replayPlot(current_plot)
                    dev.off()
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
                            plots <<- plots[-1]
                        }

                        plots[[length(plots) + 1]] <<- plot_metadata
                        recordings[[id]] <<- current_plot
                        raw_plots[[id]] <<- raw_data
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
        .vsc_rplot$on_plot_new <- function() { plot_new_called <<- TRUE }

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
                    svglite::svglite(filename = temp_file, width = 10, height = 6, bg = "white")
                    replayPlot(current_plot)
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

            writeLines(jsonlite::toJSON(list(port = port, language = "r", version = "0.49.0"), auto_unbox = TRUE), local_config_file)

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
                        writeLines(jsonlite::toJSON(list(port = port, language = "r", version = "0.49.0"), auto_unbox = TRUE), local_config_file)
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
                    if (requireNamespace("ggplot2", quietly = TRUE)) {
                        ns <- asNamespace("ggplot2")
                        if (exists("print.ggplot", envir = ns)) {
                            suppressMessages(trace("print.ggplot", print = FALSE,
                                exit = quote({
                                    options(device = .vsc_rplot$vscode_bg_device)
                                    .vsc_rplot$capture()
                                }),
                                where = ns))
                        }
                    }
                }, error = function(e) { log_debug(paste("ggplot2 trace failed:", e$message)) })
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
            last_plot <<- NULL
            msg <- toJSON(list(type = "clear_plots"), auto_unbox = TRUE)
            for (c in clients) tryCatch(c$send(msg), error = function(e) {})
        }

        .vsc_rplot$version  <- "0.49.0"
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
