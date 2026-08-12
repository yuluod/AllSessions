#define _GNU_SOURCE

#include <curl/curl.h>
#include <fcntl.h>
#include <gtk/gtk.h>
#include <glib/gstdio.h>
#include <json-glib/json-glib.h>
#include <libayatana-appindicator/app-indicator.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

#define VIEWER_URL "http://127.0.0.1:3210"
#define RELEASE_API "https://api.github.com/repos/yuluod/AllSessions/releases/latest"

typedef struct {
    char *data;
    size_t length;
} MemoryBuffer;

typedef struct {
    char *tag;
    char *name;
    char *url;
    char *digest;
    gint64 size;
    gboolean available;
    char *error;
} UpdateResult;

static char *app_root;
static GPid server_pid;
static int lock_fd = -1;
static GtkWidget *update_item;
static guint startup_checks;

static void show_dialog(GtkMessageType type, const char *title, const char *message) {
    GtkWidget *dialog = gtk_message_dialog_new(NULL, GTK_DIALOG_MODAL, type, GTK_BUTTONS_OK, "%s", title);
    gtk_message_dialog_format_secondary_text(GTK_MESSAGE_DIALOG(dialog), "%s", message);
    gtk_dialog_run(GTK_DIALOG(dialog));
    gtk_widget_destroy(dialog);
}

static void set_update_state(const char *label, gboolean enabled) {
    gtk_menu_item_set_label(GTK_MENU_ITEM(update_item), label);
    gtk_widget_set_sensitive(update_item, enabled);
}

static void reset_update_state(void) {
    set_update_state("检查更新", TRUE);
}

static size_t discard_write(void *contents, size_t size, size_t count, void *user_data) {
    (void) contents;
    (void) user_data;
    return size * count;
}

static size_t memory_write(void *contents, size_t size, size_t count, void *user_data) {
    size_t bytes = size * count;
    MemoryBuffer *buffer = user_data;
    char *expanded = realloc(buffer->data, buffer->length + bytes + 1);
    if (!expanded) return 0;
    buffer->data = expanded;
    memcpy(buffer->data + buffer->length, contents, bytes);
    buffer->length += bytes;
    buffer->data[buffer->length] = '\0';
    return bytes;
}

static gboolean viewer_available(void) {
    CURL *curl = curl_easy_init();
    if (!curl) return FALSE;
    long status = 0;
    curl_easy_setopt(curl, CURLOPT_URL, VIEWER_URL "/api/capabilities");
    curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, 1000L);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, discard_write);
    CURLcode result = curl_easy_perform(curl);
    if (result == CURLE_OK) curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
    curl_easy_cleanup(curl);
    return result == CURLE_OK && status == 200;
}

static void open_viewer(void) {
    GError *error = NULL;
    if (!gtk_show_uri_on_window(NULL, VIEWER_URL, GDK_CURRENT_TIME, &error)) {
        show_dialog(GTK_MESSAGE_ERROR, "AllSessions", error->message);
        g_error_free(error);
    }
}

static void stop_server(void) {
    if (server_pid > 0) {
        GPid pid = server_pid;
        server_pid = 0;
        kill(pid, SIGTERM);
    }
}

static void server_exited(GPid pid, gint status, gpointer user_data) {
    (void) status;
    (void) user_data;
    if (server_pid == pid) server_pid = 0;
    g_spawn_close_pid(pid);
}

static void start_server(void) {
    char *node_path = g_build_filename(app_root, "runtime", "bin", "node", NULL);
    char *server_path = g_build_filename(app_root, "server", "index.js", NULL);
    char *argv[] = { node_path, server_path, NULL };
    char **environment = g_get_environ();
    environment = g_environ_setenv(environment, "ALLSESSIONS_OPEN_BROWSER", "0", TRUE);
    GError *error = NULL;
    if (!g_spawn_async(app_root, argv, environment, G_SPAWN_DO_NOT_REAP_CHILD, NULL, NULL, &server_pid, &error)) {
        show_dialog(GTK_MESSAGE_ERROR, "AllSessions 启动失败", error->message);
        g_error_free(error);
    } else {
        g_child_watch_add(server_pid, server_exited, NULL);
    }
    g_strfreev(environment);
    g_free(node_path);
    g_free(server_path);
}

static gboolean poll_server(gpointer user_data) {
    (void) user_data;
    startup_checks += 1;
    if (viewer_available()) {
        open_viewer();
        return G_SOURCE_REMOVE;
    }
    if (server_pid > 0 && kill(server_pid, 0) != 0) {
        show_dialog(GTK_MESSAGE_ERROR, "AllSessions 启动失败", "后台服务已退出，请确认端口 3210 未被占用。");
        return G_SOURCE_REMOVE;
    }
    if (startup_checks >= 120) {
        show_dialog(GTK_MESSAGE_ERROR, "AllSessions 启动失败", "后台服务启动超时。");
        return G_SOURCE_REMOVE;
    }
    return G_SOURCE_CONTINUE;
}

static char *normalized_version(const char *value) {
    if (!value) return NULL;
    while (g_ascii_isspace(*value)) value++;
    if (*value == 'v' || *value == 'V') value++;
    return g_strdup(value);
}

static char *read_current_version(char **error_message) {
    char *path = g_build_filename(app_root, "package.json", NULL);
    char *contents = NULL;
    GError *error = NULL;
    if (!g_file_get_contents(path, &contents, NULL, &error)) {
        *error_message = g_strdup(error->message);
        g_error_free(error);
        g_free(path);
        return NULL;
    }
    JsonParser *parser = json_parser_new();
    char *version = NULL;
    if (json_parser_load_from_data(parser, contents, -1, &error)) {
        JsonObject *object = json_node_get_object(json_parser_get_root(parser));
        if (json_object_has_member(object, "version")) {
            version = normalized_version(json_object_get_string_member(object, "version"));
        }
    } else {
        *error_message = g_strdup(error->message);
        g_error_free(error);
    }
    if (!version && !*error_message) *error_message = g_strdup("安装目录中的 package.json 没有版本号。");
    g_object_unref(parser);
    g_free(contents);
    g_free(path);
    return version;
}

static const char *package_architecture(void) {
#if defined(__aarch64__)
    return "arm64";
#else
    return "x64";
#endif
}

static UpdateResult *check_update(void) {
    UpdateResult *result = g_new0(UpdateResult, 1);
    MemoryBuffer buffer = { calloc(1, 1), 0 };
    CURL *curl = curl_easy_init();
    if (!curl) {
        result->error = g_strdup("无法初始化网络组件。");
        free(buffer.data);
        return result;
    }
    struct curl_slist *headers = NULL;
    headers = curl_slist_append(headers, "Accept: application/vnd.github+json");
    headers = curl_slist_append(headers, "User-Agent: AllSessions-Linux-Launcher");
    curl_easy_setopt(curl, CURLOPT_URL, RELEASE_API);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(curl, CURLOPT_FAILONERROR, 1L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 30L);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, memory_write);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &buffer);
    CURLcode curl_result = curl_easy_perform(curl);
    if (curl_result != CURLE_OK) result->error = g_strdup(curl_easy_strerror(curl_result));
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
    if (result->error) {
        free(buffer.data);
        return result;
    }

    GError *json_error = NULL;
    JsonParser *parser = json_parser_new();
    if (!json_parser_load_from_data(parser, buffer.data, buffer.length, &json_error)) {
        result->error = g_strdup(json_error->message);
        g_error_free(json_error);
        g_object_unref(parser);
        free(buffer.data);
        return result;
    }
    JsonObject *release = json_node_get_object(json_parser_get_root(parser));
    const char *tag = json_object_get_string_member(release, "tag_name");
    char *current_error = NULL;
    char *current = read_current_version(&current_error);
    char *latest = normalized_version(tag);
    if (!current || !latest) {
        result->error = current_error ? current_error : g_strdup("GitHub 返回的数据中没有版本号。");
        g_free(current);
        g_free(latest);
        g_object_unref(parser);
        free(buffer.data);
        return result;
    }
    if (strverscmp(latest, current) <= 0) {
        result->available = FALSE;
        result->tag = g_strdup(tag);
        g_free(current);
        g_free(latest);
        g_object_unref(parser);
        free(buffer.data);
        return result;
    }

    char *expected_name = g_strdup_printf("AllSessions-%s-linux-%s.deb", latest, package_architecture());
    JsonArray *assets = json_object_get_array_member(release, "assets");
    guint length = json_array_get_length(assets);
    for (guint index = 0; index < length; index++) {
        JsonObject *asset = json_array_get_object_element(assets, index);
        const char *name = json_object_get_string_member(asset, "name");
        if (g_ascii_strcasecmp(name, expected_name) == 0) {
            result->available = TRUE;
            result->tag = g_strdup(tag);
            result->name = g_strdup(name);
            result->url = g_strdup(json_object_get_string_member(asset, "browser_download_url"));
            result->size = json_object_get_int_member(asset, "size");
            JsonNode *digest_node = json_object_get_member(asset, "digest");
            if (digest_node && !JSON_NODE_HOLDS_NULL(digest_node)) {
                result->digest = g_strdup(json_object_get_string_member(asset, "digest"));
            }
            break;
        }
    }
    if (!result->available) result->error = g_strdup_printf("新版本中没有找到安装包：%s", expected_name);
    g_free(expected_name);
    g_free(current);
    g_free(latest);
    g_object_unref(parser);
    free(buffer.data);
    return result;
}

static void free_update_result(UpdateResult *result) {
    if (!result) return;
    g_free(result->tag);
    g_free(result->name);
    g_free(result->url);
    g_free(result->digest);
    g_free(result->error);
    g_free(result);
}

static gboolean validate_download_url(const char *value) {
    GError *error = NULL;
    GUri *uri = g_uri_parse(value, G_URI_FLAGS_NONE, &error);
    gboolean valid = uri && g_strcmp0(g_uri_get_scheme(uri), "https") == 0
        && g_uri_get_host(uri) && g_ascii_strcasecmp(g_uri_get_host(uri), "github.com") == 0;
    if (uri) g_uri_unref(uri);
    if (error) g_error_free(error);
    return valid;
}

static size_t file_write(void *contents, size_t size, size_t count, void *user_data) {
    return fwrite(contents, size, count, user_data);
}

static gboolean validate_installer(const char *path, const UpdateResult *update, char **error_message) {
    struct stat info;
    if (stat(path, &info) != 0 || info.st_size < 8) {
        *error_message = g_strdup("下载的安装程序为空。");
        return FALSE;
    }
    if (update->size > 0 && info.st_size != update->size) {
        *error_message = g_strdup("下载的安装程序大小与 Release 记录不一致。");
        return FALSE;
    }
    FILE *file = fopen(path, "rb");
    if (!file) {
        *error_message = g_strdup("无法读取下载的安装程序。");
        return FALSE;
    }
    char magic[8];
    gboolean valid_magic = fread(magic, 1, sizeof(magic), file) == sizeof(magic)
        && memcmp(magic, "!<arch>\n", sizeof(magic)) == 0;
    fclose(file);
    if (!valid_magic) {
        *error_message = g_strdup("下载的文件不是有效的 Debian 安装程序。");
        return FALSE;
    }
    if (update->digest && g_ascii_strncasecmp(update->digest, "sha256:", 7) == 0) {
        GChecksum *checksum = g_checksum_new(G_CHECKSUM_SHA256);
        file = fopen(path, "rb");
        unsigned char chunk[1024 * 1024];
        size_t bytes;
        while ((bytes = fread(chunk, 1, sizeof(chunk), file)) > 0) g_checksum_update(checksum, chunk, bytes);
        fclose(file);
        gboolean matches = g_ascii_strcasecmp(g_checksum_get_string(checksum), update->digest + 7) == 0;
        g_checksum_free(checksum);
        if (!matches) {
            *error_message = g_strdup("下载的安装程序 SHA-256 校验失败。");
            return FALSE;
        }
    }
    return TRUE;
}

static gboolean download_result_ui(gpointer user_data) {
    UpdateResult *result = user_data;
    if (result->error) {
        show_dialog(GTK_MESSAGE_ERROR, "AllSessions 更新", result->error);
        reset_update_state();
    } else {
        char *argv[] = { "xdg-open", result->url, NULL };
        GError *error = NULL;
        if (g_spawn_async(NULL, argv, NULL, G_SPAWN_SEARCH_PATH, NULL, NULL, NULL, &error)) {
            stop_server();
            gtk_main_quit();
        } else {
            show_dialog(GTK_MESSAGE_ERROR, "AllSessions 更新", error->message);
            g_error_free(error);
            reset_update_state();
        }
    }
    free_update_result(result);
    return G_SOURCE_REMOVE;
}

static gpointer download_update_thread(gpointer user_data) {
    UpdateResult *result = user_data;
    char *directory = g_build_filename(g_get_tmp_dir(), "AllSessions", "updates", NULL);
    g_mkdir_with_parents(directory, 0700);
    char *path = g_build_filename(directory, result->name, NULL);
    char *partial = g_strconcat(path, ".download", NULL);
    g_unlink(partial);
    if (!validate_download_url(result->url)) {
        result->error = g_strdup("更新包下载地址无效。");
    } else {
        FILE *file = fopen(partial, "wb");
        CURL *curl = file ? curl_easy_init() : NULL;
        if (!file || !curl) {
            result->error = g_strdup("无法创建更新包临时文件。");
            if (file) fclose(file);
        } else {
            curl_easy_setopt(curl, CURLOPT_URL, result->url);
            curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
            curl_easy_setopt(curl, CURLOPT_FAILONERROR, 1L);
            curl_easy_setopt(curl, CURLOPT_USERAGENT, "AllSessions-Linux-Launcher");
            curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, file_write);
            curl_easy_setopt(curl, CURLOPT_WRITEDATA, file);
            CURLcode code = curl_easy_perform(curl);
            if (code != CURLE_OK) result->error = g_strdup(curl_easy_strerror(code));
            curl_easy_cleanup(curl);
            fclose(file);
        }
        if (result->error) g_unlink(partial);
        if (!result->error && !validate_installer(partial, result, &result->error)) g_unlink(partial);
        if (!result->error) {
            g_unlink(path);
            if (g_rename(partial, path) != 0) result->error = g_strdup("无法保存下载的安装程序。");
        }
    }
    g_free(result->url);
    result->url = path;
    g_free(partial);
    g_free(directory);
    g_idle_add(download_result_ui, result);
    return NULL;
}

static gboolean update_result_ui(gpointer user_data) {
    UpdateResult *result = user_data;
    if (result->error) {
        char *message = g_strdup_printf("检查更新失败：%s", result->error);
        show_dialog(GTK_MESSAGE_ERROR, "AllSessions 更新", message);
        g_free(message);
        reset_update_state();
        free_update_result(result);
        return G_SOURCE_REMOVE;
    }
    if (!result->available) {
        show_dialog(GTK_MESSAGE_INFO, "AllSessions 更新", "当前版本已是最新版本。");
        reset_update_state();
        free_update_result(result);
        return G_SOURCE_REMOVE;
    }

    char *message = g_strdup_printf("发现新版本 %s，是否立即下载并安装？", result->tag);
    GtkWidget *dialog = gtk_message_dialog_new(NULL, GTK_DIALOG_MODAL, GTK_MESSAGE_INFO, GTK_BUTTONS_YES_NO, "%s", "AllSessions 更新");
    gtk_message_dialog_format_secondary_text(GTK_MESSAGE_DIALOG(dialog), "%s", message);
    gint response = gtk_dialog_run(GTK_DIALOG(dialog));
    gtk_widget_destroy(dialog);
    g_free(message);
    if (response == GTK_RESPONSE_YES) {
        char *label = g_strdup_printf("正在下载 %s…", result->tag);
        set_update_state(label, FALSE);
        g_free(label);
        g_thread_unref(g_thread_new("allsessions-download", download_update_thread, result));
    } else {
        reset_update_state();
        free_update_result(result);
    }
    return G_SOURCE_REMOVE;
}

static gpointer check_update_thread(gpointer user_data) {
    (void) user_data;
    g_idle_add(update_result_ui, check_update());
    return NULL;
}

static void check_for_updates(void) {
    set_update_state("正在检查更新…", FALSE);
    g_thread_unref(g_thread_new("allsessions-update", check_update_thread, NULL));
}

static void exit_application(void) {
    stop_server();
    gtk_main_quit();
}

static char *resolve_app_root(void) {
    char executable[4096];
    ssize_t length = readlink("/proc/self/exe", executable, sizeof(executable) - 1);
    if (length <= 0) return g_get_current_dir();
    executable[length] = '\0';
    return g_path_get_dirname(executable);
}

int main(int argc, char **argv) {
    (void) argv;
    gtk_init(&argc, &argv);
    curl_global_init(CURL_GLOBAL_DEFAULT);
    app_root = resolve_app_root();

    char *lock_path = g_strdup_printf("%s/allsessions-%u.lock", g_get_tmp_dir(), (unsigned int) getuid());
    lock_fd = open(lock_path, O_CREAT | O_RDWR, 0600);
    g_free(lock_path);
    if (lock_fd >= 0 && flock(lock_fd, LOCK_EX | LOCK_NB) != 0) {
        open_viewer();
        return 0;
    }

    char *icon_path = g_build_filename(app_root, "public", "assets", NULL);
    AppIndicator *indicator = app_indicator_new_with_path(
        "allsessions", "allsessions-icon-v2", APP_INDICATOR_CATEGORY_APPLICATION_STATUS, icon_path
    );
    app_indicator_set_status(indicator, APP_INDICATOR_STATUS_ACTIVE);
    app_indicator_set_title(indicator, "AllSessions");

    GtkWidget *menu = gtk_menu_new();
    GtkWidget *open_item = gtk_menu_item_new_with_label("打开 AllSessions");
    update_item = gtk_menu_item_new_with_label("检查更新");
    GtkWidget *separator = gtk_separator_menu_item_new();
    GtkWidget *exit_item = gtk_menu_item_new_with_label("退出");
    g_signal_connect_swapped(open_item, "activate", G_CALLBACK(open_viewer), NULL);
    g_signal_connect_swapped(update_item, "activate", G_CALLBACK(check_for_updates), NULL);
    g_signal_connect_swapped(exit_item, "activate", G_CALLBACK(exit_application), NULL);
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), open_item);
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), update_item);
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), separator);
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), exit_item);
    gtk_widget_show_all(menu);
    app_indicator_set_menu(indicator, GTK_MENU(menu));
    g_free(icon_path);

    if (viewer_available()) {
        open_viewer();
    } else {
        start_server();
        g_timeout_add(500, poll_server, NULL);
    }
    gtk_main();

    stop_server();
    if (lock_fd >= 0) close(lock_fd);
    g_free(app_root);
    curl_global_cleanup();
    return 0;
}
