# R Plot Pro WebSocket Server - Encapsulated

# Create global hidden environment if it doesn't exist
if (!exists(".vsc_rplot", envir = .GlobalEnv)) {
    assign(".vsc_rplot", new.env(parent = .GlobalEnv), envir = .GlobalEnv)
}

local(
    {
        # Gerekli paketleri yükle
        if (!require("httpuv", quietly = TRUE)) {
            install.packages("httpuv")
        }
        if (!require("jsonlite", quietly = TRUE)) {
            install.packages("jsonlite")
        }
        if (!require("base64enc", quietly = TRUE)) {
            install.packages("base64enc")
        }
        if (!require("svglite", quietly = TRUE)) {
            install.packages("svglite")
        }

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
        timer_pending <- FALSE
        last_activity <- Sys.time()

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
            # Language Isolation: Only handle R plots with explicit 'r-' prefix
            if (is.null(plot_id) || !startsWith(as.character(plot_id), "r-")) {
                return(NULL)
            }
            
            pid <- as.character(plot_id)
            if (is.null(recordings[[pid]])) {
                # Try to match in plots list to find the 'true' key (defensive)
                for (p in plots) {
                    if (as.character(p$id) == pid) {
                        pid <- as.character(p$id)
                        break
                    }
                }
            }
            
            if (!is.null(recordings[[pid]])) {
                target_plot <- recordings[[pid]]
            } else {
                # Fallback to last_plot if ID not found BUT prefix matches 'r-'
                # Safe because Frontend routes specifically to our port.
                target_plot <- last_plot
            }
            
            if (!is.null(target_plot)) {
                capture_and_send(target_plot, width, height, update_id = pid)
            }
        }
        # Capture and send to webview
        capture_and_send <- function(target_plot, width, height, update_id = NULL) {
            if (is.null(target_plot)) return(NULL)
            if (width < 50) width <- 50
            if (height < 50) height <- 50

            tryCatch(
                {
                    width_in <- width / 96
                    height_in <- height / 96
                    temp_file <- tempfile(fileext = ".svg")
                    svglite::svglite(
                        filename = temp_file,
                        width = width_in,
                        height = height_in,
                        bg = "white"
                    )
                    replayPlot(target_plot)
                    dev.off()

                    if (file.exists(temp_file)) {
                        readBin(temp_file, "raw", file.info(temp_file)$size)
                    } else {
                        NULL
                    }
                },
                error = function(e) NULL,
                finally = {
                    if (exists("temp_file") && file.exists(temp_file)) unlink(temp_file)
                }
            )
        }

        # WebSocket handler
        plot_ws_handler <- function(ws) {
            client_id <- as.character(runif(1))
            ws$onMessage(function(binary, message) {
                tryCatch(
                    {
                        data <- fromJSON(message)
                        if (data$type == "ping") {
                            ws$send(toJSON(list(type = "pong")))
                        } else if (data$type == "get_plots") {
                            # Send metadata list
                            ws$send(toJSON(
                                list(type = "plot_list", plots = plots),
                                auto_unbox = TRUE
                            ))
                            # Follow up with binary data for each if requested or just let client ask
                            # For now, we'll send binary for the most recent one if history is shown
                        } else if (data$type == "request_binary") {
                            pid <- as.character(data$plot_id)
                            if (!is.null(raw_plots[[pid]])) {
                                # Find format from metadata
                                fmt <- "svg" 
                                for (p in plots) {
                                  if (as.character(p$id) == pid) {
                                    fmt <- p$format
                                    break
                                  }
                                }
                                send_binary_to_client(ws, "update_plot", raw_plots[[pid]], list(id = pid, format = fmt))
                            }
                        } else if (data$type == "clear_all") {
                            # Assigned to parent scope variables
                            plots <<- list()
                            recordings <<- list()
                        } else if (data$type == "delete_plot") {
                                pid <- as.character(data$plot_id)
                                recordings[[pid]] <<- NULL
                                raw_plots[[pid]] <<- NULL
                                plots <<- Filter(
                                    function(x) as.character(x$id) != pid,
                                    plots
                                )
                                # Broadcast updated list to ALL clients
                                msg <- toJSON(list(type = "plot_list", plots = plots), auto_unbox = TRUE)
                                for (c in clients) {
                                    tryCatch(c$send(msg), error = function(e) {})
                                }
                            } else if (data$type == "resize") {
                                w <- as.integer(data$width)
                                h <- as.integer(data$height)
                                client_dims$width <<- w
                                client_dims$height <<- h
                                
                                raw_data <- handle_resize_request(w, h, data$plot_id)
                                
                                if (!is.null(raw_data)) {
                                    # Identify which plot was actually rendered
                                    pid <- if (!is.null(data$plot_id)) as.character(data$plot_id) else NULL
                                    
                                    # If ID is missing or not in our list, use the latest plot's ID
                                    if (is.null(pid) || length(plots) == 0) {
                                        if (length(plots) > 0) pid <- plots[[length(plots)]]$id
                                    } else {
                                        # Verify ID exists in plots
                                        ids <- sapply(plots, function(x) as.character(x$id))
                                        if (!(pid %in% ids) && length(plots) > 0) {
                                            pid <- plots[[length(plots)]]$id
                                        }
                                    }
                                    
                                    if (!is.null(pid)) {
                                        # Find format
                                        fmt <- "svg"
                                        for (p in plots) {
                                            if (as.character(p$id) == pid) {
                                                fmt <- p$format
                                                break
                                            }
                                        }
                                        send_binary_to_client(ws, "update_plot", raw_data, list(id = pid, format = fmt))
                                    }
                                }
                            } else if (data$type == "set_active_file") {
                            # Functionality removed as per cleanup
                        }
                    },
                    error = function(e) {}
                )
            })
            ws$onClose(function() {
                clients[[client_id]] <<- NULL
            })
            clients[[client_id]] <<- ws
            if (length(plots) > 0) {
                ws$send(toJSON(
                    list(type = "plot_list", plots = plots),
                    auto_unbox = TRUE
                ))
            }
        }

        # HTTP handler
        plot_http_handler <- function(req) {
            if (req$PATH_INFO == "/") {
                html_file <- file.path(script_dir, "plot_viewer.html")
                if (!file.exists(html_file)) {
                    html_file <- "plot_viewer.html"
                }
                if (file.exists(html_file)) {
                    html_content <- readLines(html_file, warn = FALSE)
                    list(
                        status = 200L,
                        headers = list("Content-Type" = "text/html"),
                        body = paste(html_content, collapse = "\n")
                    )
                } else {
                    list(
                        status = 404L,
                        headers = list("Content-Type" = "text/plain"),
                        body = "Not found"
                    )
                }
            } else {
                list(
                    status = 404L,
                    headers = list("Content-Type" = "text/plain"),
                    body = "Not found"
                )
            }
        }

        send_binary_to_client <- function(client_ws, type, bin_payload, metadata = list()) {
            metadata$type <- type
            meta_json <- toJSON(metadata, auto_unbox = TRUE)
            meta_bytes <- charToRaw(meta_json)
            meta_len <- length(meta_bytes)
            
            # Pack: [Uint32 LEN][JSON META][PAYLOAD]
            con <- rawConnection(raw(0), "wb")
            writeBin(as.integer(meta_len), con, size = 4, endian = "big")
            writeBin(meta_bytes, con)
            writeBin(bin_payload, con)
            full_frame <- rawConnectionValue(con)
            close(con)
            
            tryCatch(client_ws$send(full_frame), error = function(e) {})
        }

        send_plot_to_clients <- function(raw_data, metadata = list()) {
            for (client in clients) {
                send_binary_to_client(client, "new_plot", raw_data, metadata)
            }
        }

        process_internal_capture <- function(
            current_plot,
            explicit_source_info = NULL
        ) {
            if (is.null(current_plot)) {
                return()
            }
            if (!identical(current_plot, last_plot)) {
                width_px <- client_dims$width
                height_px <- client_dims$height
                width_in <- max(width_px / 96, 2)
                height_in <- max(height_px / 96, 2)

                temp_file <- tempfile(fileext = ".svg")
                svglite::svglite(
                    filename = temp_file,
                    width = width_in,
                    height = height_in,
                    bg = "white"
                )
                replayPlot(current_plot)
                dev.off()

                if (file.exists(temp_file)) {
                    fsize <- file.size(temp_file)
                    if (fsize < 400) {
                        unlink(temp_file)
                        return()
                    }
                    
                    raw_data <- readBin(temp_file, "raw", fsize)
                    id <- sprintf("r-%.0f", as.numeric(Sys.time()) * 1000)

                    # Determine source code information
                    source_info <- NULL

                    if (!is.null(explicit_source_info)) {
                        # Use provided info (e.g. from hook capturing previous plot)
                        source_info <- explicit_source_info
                    }

                    plot_metadata <- list(
                        id = id,
                        timestamp = format(Sys.time(), "%H:%M:%S"),
                        format = "svg"
                    )

                    MAX_PLOTS <- 200
                    if (length(plots) >= MAX_PLOTS) {
                        oldest_id <- plots[[1]]$id
                        recordings[[oldest_id]] <<- NULL
                        raw_plots[[oldest_id]] <<- NULL
                        plots <<- plots[-1]
                    }

                    plots[[length(plots) + 1]] <<- plot_metadata
                    recordings[[id]] <<- current_plot
                    raw_plots[[id]] <<- raw_data
                    last_plot <<- current_plot

                    send_plot_to_clients(raw_data, plot_metadata)
                    unlink(temp_file)
                }
            }
        }

        on_plot_new_hook <- function() {
            # 1. If there's a finished plot on the device, capture it NOW
            if (dev.cur() > 1) {
                tryCatch(
                    {
                        mfg <- par("mfg")
                        is_last_cell <- (mfg[1] == mfg[3] && mfg[2] == mfg[4])
                        if (is_last_cell) {
                            current_plot <- recordPlot()
                            process_internal_capture(current_plot)
                        }
                    },
                    error = function(e) {}
                )
            }
        }
        .vsc_rplot$.on_plot_new_hook <- on_plot_new_hook

        # Special hook for ggplot plots - now just an alias as we don't capture source
        on_ggplot_print_hook <- function() {
            on_plot_new_hook()
        }
        .vsc_rplot$.on_ggplot_print_hook <- on_ggplot_print_hook

        check_for_new_plot <- function(expr, value, ok, visible) {
            if (dev.cur() > 1) {
                tryCatch(
                    {
                        current_plot <- recordPlot()
                        process_internal_capture(current_plot)
                    },
                    error = function(e) {}
                )
            }
            return(TRUE)
        }

        vscode_bg_device <- function(...) {
            svglite::svglite(
                filename = tempfile(),
                width = 10,
                height = 6,
                bg = "white",
                ...
            )
            dev.control("enable")
        }

        # Public functions assigned to .vsc_rplot
        .vsc_rplot$start_plot_viewer <- function(port = NULL) {
            if (!is.null(server)) {
                stopServer(server)
                server <<- NULL
            }
            if (is.null(port)) {
                port <- sample(10000:30000, 1)
            }

            env_config_path <- Sys.getenv("VSCODE_R_PLOT_CONFIG")
            local_config_file <- if (nzchar(env_config_path)) {
                if (isTRUE(file.info(env_config_path)$isdir)) {
                    file.path(env_config_path, paste0("port_", port, ".json"))
                } else {
                    env_config_path
                }
            } else {
                file.path(getwd(), ".r_plot_config.json")
            }

            writeLines(
                jsonlite::toJSON(list(port = port, language = "r"), auto_unbox = TRUE),
                local_config_file
            )

            # Register cleanup
            reg.finalizer(parent.frame(), function(e) {
                if (file.exists(local_config_file)) unlink(local_config_file)
            }, onexit = TRUE)

            tryCatch(
                {
                    server <<- startServer(
                        host = "127.0.0.1",
                        port = port,
                        app = list(
                            call = plot_http_handler,
                            onWSOpen = plot_ws_handler
                        )
                    )
                },
                error = function(e) {
                    if (
                        grepl(
                            "address already in use",
                            e$message,
                            ignore.case = TRUE
                        )
                    ) {
                        system(
                            sprintf("lsof -ti:%d | xargs kill -9", port),
                            ignore.stderr = TRUE
                        )
                        Sys.sleep(1)
                        server <<- startServer(
                            host = "127.0.0.1",
                            port = port,
                            app = list(
                                call = plot_http_handler,
                                onWSOpen = plot_ws_handler
                            )
                        )
                    } else {
                        stop(e)
                    }
                }
            )

            if (is.null(server)) {
                return(invisible(NULL))
            }

            options(device = vscode_bg_device)
            if (!is.null(callback_id)) {
                removeTaskCallback(callback_id)
            }
            callback_id <<- addTaskCallback(
                check_for_new_plot,
                name = "plot_viewer_watcher"
            )

            tryCatch(
                {
                    suppressMessages(trace(
                        graphics::plot.new,
                        print = FALSE,
                        tracer = quote(.vsc_rplot$.on_plot_new_hook()),
                        where = asNamespace("graphics")
                    ))
                    if (requireNamespace("grid", quietly = TRUE)) {
                        suppressMessages(trace(
                            grid::grid.newpage,
                            print = FALSE,
                            tracer = quote(.vsc_rplot$.on_plot_new_hook()),
                            where = asNamespace("grid")
                        ))
                    }
                    if (requireNamespace("ggplot2", quietly = TRUE)) {
                        suppressMessages(trace(
                            ggplot2::print.ggplot,
                            print = FALSE,
                            tracer = quote(.vsc_rplot$.on_ggplot_print_hook()),
                            where = asNamespace("ggplot2")
                        ))
                    }
                },
                error = function(e) {}
            )

            invisible(server)
        }

        .vsc_rplot$stop_plot_viewer <- function() {
            if (!is.null(server)) {
                stopServer(server)
                server <<- NULL
            }
            if (!is.null(callback_id)) {
                removeTaskCallback(callback_id)
                callback_id <<- NULL
            }
            tryCatch(
                {
                    suppressMessages(untrace(
                        "plot.new",
                        where = asNamespace("graphics")
                    ))
                    if (requireNamespace("grid", quietly = TRUE)) {
                        suppressMessages(untrace(
                            "grid.newpage",
                            where = asNamespace("grid")
                        ))
                    }
                    if (requireNamespace("ggplot2", quietly = TRUE)) {
                        suppressMessages(untrace(
                            "print.ggplot",
                            where = asNamespace("ggplot2")
                        ))
                    }
                },
                error = function(e) {}
            )
        }

        .vsc_rplot$clear_plots <- function() {
            plots <<- list()
            recordings <<- list()
            last_plot <<- NULL
            msg <- toJSON(list(type = "clear_plots"), auto_unbox = TRUE)
            for (c in clients) {
                tryCatch(c$send(msg), error = function(e) {})
            }
        }

        # Expose run_file helper (noop now but kept for compatibility)
        .vsc_rplot$run_file <- function(file_path) {
            # source highlighting disabled
            utils::source(file_path)
            invisible(NULL)
        }
    },
    envir = .vsc_rplot
)
