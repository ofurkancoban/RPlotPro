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
            missing <- pkgs[!(pkgs %in% installed.packages()[, "Package"])]
            
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
        throttle_ms <- 500 # Minimum time between captures
        
        # Debug logging
        log_debug <- function(msg) {
            tryCatch({
                cat(paste0("[", format(Sys.time(), "%H:%M:%S"), "] ", msg, "\n"), 
                    file = "/tmp/rplot_debug.log", append = TRUE)
            }, error = function(e) {})
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

        process_internal_capture <- function(current_plot, temp_file_path = NULL) {
            if (is.null(current_plot)) return()
            now <- as.numeric(Sys.time()) * 1000
            if (now - last_capture_time < throttle_ms) return()
            
            if (!identical(current_plot, last_plot)) {
                last_plot <<- current_plot
                last_capture_time <<- now
                log_debug(paste("Capturing plot at", format(Sys.time(), "%H:%M:%S")))

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
                    id <- sprintf("r-%.0f", as.numeric(Sys.time()) * 1000)
                    plot_metadata <- list(id = id, timestamp = format(Sys.time(), "%H:%M:%S"), format = "svg")

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
                    unlink(temp_file)
                }
            }
        }

        # Manual capture helper
        .vsc_rplot$capture <- function() {
            log_debug("Manual capture requested")
            safe_capture(force = TRUE)
        }
        
        # Robust capture logic
        safe_capture <- function(force = FALSE) {
            if (isTRUE(in_capture)) return()
            if (dev.cur() <= 1) return()
            
            tryCatch({
                current_plot <- recordPlot()
                if (is.null(current_plot)) return()
                
                if (force || !identical(current_plot, last_plot)) {
                    if (!force) {
                        now <- as.numeric(Sys.time()) * 1000
                        if (now - last_capture_time < throttle_ms) return()
                    }
                    
                    in_capture <<- TRUE
                    on.exit(in_capture <<- FALSE)
                    
                    temp_file <- tempfile(fileext = ".svg")
                    svglite::svglite(filename = temp_file, width = 10, height = 6, bg = "white")
                    replayPlot(current_plot)
                    dev.off()
                    
                    process_internal_capture(current_plot, temp_file_path = temp_file)
                }
            }, error = function(e) { log_debug(paste("Capture Error:", e$message)) })
        }
        
        check_for_new_plot <- function(expr, value, ok, visible) {
            safe_capture()
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
            if (!is.null(server)) { stopServer(server); server <<- NULL }
            if (is.null(port)) port <- sample(10000:30000, 1)

            env_config_path <- Sys.getenv("VSCODE_R_PLOT_CONFIG")
            local_config_file <- if (nzchar(env_config_path)) {
                if (isTRUE(file.info(env_config_path)$isdir)) file.path(env_config_path, paste0("port_", port, ".json")) else env_config_path
            } else file.path(getwd(), ".r_plot_config.json")

            writeLines(jsonlite::toJSON(list(port = port, language = "r", version = "0.45.0"), auto_unbox = TRUE), local_config_file)

            reg.finalizer(.GlobalEnv, function(e) { if (file.exists(local_config_file)) unlink(local_config_file) }, onexit = TRUE)

            tryCatch({
                server <<- startServer(host = "127.0.0.1", port = port, app = list(call = plot_http_handler, onWSOpen = plot_ws_handler))
            }, error = function(e) {
                if (grepl("address already in use", e$message, ignore.case = TRUE)) {
                    system(sprintf("lsof -ti:%d | xargs kill -9", port), ignore.stderr = TRUE)
                    Sys.sleep(1)
                    server <<- startServer(host = "127.0.0.1", port = port, app = list(call = plot_http_handler, onWSOpen = plot_ws_handler))
                } else stop(e)
            })

            if (is.null(server)) return(invisible(NULL))

            options(device = vscode_bg_device)
            
            if (!is.null(callback_id)) removeTaskCallback(callback_id)
            callback_id <<- addTaskCallback(check_for_new_plot, name = "plot_viewer_watcher")

            tryCatch({
                if (requireNamespace("ggplot2", quietly = TRUE)) {
                    ns <- asNamespace("ggplot2")
                    if (exists("print.ggplot", envir = ns)) {
                        suppressMessages(trace("print.ggplot", print = FALSE, exit = quote({
                            options(device = .vsc_rplot$vscode_bg_device)
                            .vsc_rplot$capture()
                        }), where = ns))
                    }
                }
            }, error = function(e) { log_debug(paste("Trace Error:", e$message)) })

            invisible(server)
        }

        .vsc_rplot$stop_plot_viewer <- function() {
            if (!is.null(server)) { stopServer(server); server <<- NULL }
            if (!is.null(callback_id)) { removeTaskCallback(callback_id); callback_id <<- NULL }
            tryCatch({
                if (requireNamespace("ggplot2", quietly = TRUE)) {
                    suppressMessages(untrace("print.ggplot", where = asNamespace("ggplot2")))
                }
            }, error = function(e) {})
        }

        .vsc_rplot$clear_plots <- function() {
            plots <<- list()
            recordings <<- list()
            last_plot <<- NULL
            msg <- toJSON(list(type = "clear_plots"), auto_unbox = TRUE)
            for (c in clients) tryCatch(c$send(msg), error = function(e) {})
        }

        .vsc_rplot$run_file <- function(file_path) { utils::source(file_path); invisible(NULL) }
    },
    envir = .vsc_rplot
)
