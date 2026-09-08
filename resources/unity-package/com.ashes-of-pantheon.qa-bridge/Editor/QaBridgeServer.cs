using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using Newtonsoft.Json;
using Newtonsoft.Json.Serialization;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace AshesOfPantheon.QA.EditorBridge
{
    internal sealed class QaBridgeServer : IDisposable
    {
        private readonly QaGameReflectionAdapter m_adapter;
        private readonly JsonSerializerSettings m_jsonSettings = new JsonSerializerSettings
        {
            ContractResolver = new CamelCasePropertyNamesContractResolver(),
            NullValueHandling = NullValueHandling.Ignore
        };

        private HttpListener m_listener;
        private Thread m_listenerThread;
        private string m_token;
        private string m_instanceId;
        private string m_rendezvousPath;
        private int m_port;
        private bool m_disposed;
        private double m_nextHeartbeat;

        public QaBridgeServer(QaGameReflectionAdapter adapter)
        {
            m_adapter = adapter;
        }

        public void Start()
        {
            if (m_listener != null)
            {
                return;
            }

            m_port = ReservePort();
            m_token = CreateToken();
            m_instanceId = $"editor-{Process.GetCurrentProcess().Id}";
            m_listener = new HttpListener();
            m_listener.Prefixes.Add($"http://127.0.0.1:{m_port}/");

            try
            {
                m_listener.Start();
            }
            catch (Exception exception)
            {
                m_listener.Close();
                m_listener = null;
                UnityEngine.Debug.LogError($"[AshesOfPantheonQA] Editor Bridge failed to start: {exception.Message}");
                return;
            }

            WriteRendezvousFile();
            EditorApplication.update += Heartbeat;
            m_listenerThread = new Thread(ListenLoop)
            {
                IsBackground = true,
                Name = "Ashes of Pantheon QA Editor Bridge"
            };
            m_listenerThread.Start();
            UnityEngine.Debug.Log($"[AshesOfPantheonQA] Editor Bridge listening on 127.0.0.1:{m_port}");
        }

        public void Dispose()
        {
            if (m_disposed)
            {
                return;
            }

            m_disposed = true;
            EditorApplication.update -= Heartbeat;
            try
            {
                m_listener?.Stop();
                m_listener?.Close();
            }
            catch (Exception exception)
            {
                UnityEngine.Debug.LogWarning($"[AshesOfPantheonQA] Listener cleanup was incomplete: {exception.Message}");
            }

            if (!string.IsNullOrEmpty(m_rendezvousPath) && File.Exists(m_rendezvousPath))
            {
                try
                {
                    File.Delete(m_rendezvousPath);
                }
                catch (Exception exception)
                {
                    UnityEngine.Debug.LogWarning($"[AshesOfPantheonQA] Rendezvous cleanup was incomplete: {exception.Message}");
                }
            }
        }

        private void ListenLoop()
        {
            while (!m_disposed && m_listener != null && m_listener.IsListening)
            {
                try
                {
                    var context = m_listener.GetContext();
                    ThreadPool.QueueUserWorkItem(_ => Handle(context));
                }
                catch (HttpListenerException)
                {
                    if (!m_disposed)
                    {
                        Thread.Sleep(100);
                    }
                }
                catch (ObjectDisposedException)
                {
                    return;
                }
            }
        }

        private void Handle(HttpListenerContext context)
        {
            try
            {
                if (!IsAuthorized(context.Request))
                {
                    WriteJson(context.Response, 401, new { error = "unauthorized" });
                    return;
                }

                var path = context.Request.Url?.AbsolutePath ?? string.Empty;
                object payload;
                if (context.Request.HttpMethod == "GET" && path == "/api/status")
                {
                    payload = QaMainThreadDispatcher.Invoke(m_adapter.GetStatus);
                }
                else if (context.Request.HttpMethod == "GET" && path == "/api/catalog")
                {
                    payload = QaMainThreadDispatcher.Invoke(m_adapter.GetCatalog);
                }
                else if (context.Request.HttpMethod == "GET" && path == "/api/battle")
                {
                    payload = QaMainThreadDispatcher.Invoke(m_adapter.GetBattleSnapshot);
                }
                else if (context.Request.HttpMethod == "GET" && path == "/api/battle/route-preview")
                {
                    payload = QaMainThreadDispatcher.Invoke(m_adapter.GetRoutePreviewSnapshot);
                }
                else if (context.Request.HttpMethod == "GET" && path == "/api/cards")
                {
                    payload = QaMainThreadDispatcher.Invoke(m_adapter.GetCardInventorySnapshot);
                }
                else if (context.Request.HttpMethod == "POST" && path == "/api/cards")
                {
                    var request = JObject.Parse(ReadBody(context.Request));
                    payload = QaMainThreadDispatcher.Invoke(() => m_adapter.AddOwnedCard(request));
                }
                else if (context.Request.HttpMethod == "DELETE" && path == "/api/cards")
                {
                    var request = JObject.Parse(ReadBody(context.Request));
                    payload = QaMainThreadDispatcher.Invoke(() => m_adapter.RemoveOwnedCard(request));
                }
                else if (context.Request.HttpMethod == "POST" && path == "/api/gm")
                {
                    var request = JsonConvert.DeserializeObject<GmRequest>(ReadBody(context.Request));
                    payload = QaMainThreadDispatcher.Invoke(() => m_adapter.ExecuteGm(request?.Command));
                }
                else if (context.Request.HttpMethod == "POST" && path == "/api/entities/move")
                {
                    var request = JObject.Parse(ReadBody(context.Request));
                    request["expiresAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 4000;
                    payload = QaMainThreadDispatcher.Invoke(() => m_adapter.MoveEntity(request));
                }
                else if (context.Request.HttpMethod == "DELETE" && path == "/api/equipment")
                {
                    var request = JObject.Parse(ReadBody(context.Request));
                    payload = QaMainThreadDispatcher.Invoke(() => m_adapter.RemoveEquipment(request));
                }
                else if (context.Request.HttpMethod == "POST" && path == "/api/player")
                {
                    var request = JObject.Parse(ReadBody(context.Request));
                    payload = QaMainThreadDispatcher.Invoke(() => m_adapter.ApplyPlayer(request));
                }
                else if (context.Request.HttpMethod == "POST" && path == "/api/enemy")
                {
                    var request = JObject.Parse(ReadBody(context.Request));
                    payload = QaMainThreadDispatcher.Invoke(() => m_adapter.ApplyEnemy(request));
                }
                else if (context.Request.HttpMethod == "POST" && path == "/api/buffs")
                {
                    var request = JObject.Parse(ReadBody(context.Request));
                    payload = QaMainThreadDispatcher.Invoke(() => m_adapter.AddBuff(request));
                }
                else if (context.Request.HttpMethod == "DELETE" && path == "/api/buffs")
                {
                    var request = JObject.Parse(ReadBody(context.Request));
                    payload = QaMainThreadDispatcher.Invoke(() => m_adapter.RemoveBuff(request));
                }
                else if (context.Request.HttpMethod == "PATCH" && path == "/api/buffs")
                {
                    var request = JObject.Parse(ReadBody(context.Request));
                    payload = QaMainThreadDispatcher.Invoke(() => m_adapter.UpdateBuff(request));
                }
                else if (context.Request.HttpMethod == "POST" && path == "/api/blessings")
                {
                    var request = JObject.Parse(ReadBody(context.Request));
                    payload = QaMainThreadDispatcher.Invoke(() => m_adapter.AddBlessing(request));
                }
                else if (context.Request.HttpMethod == "DELETE" && path == "/api/blessings")
                {
                    var request = JObject.Parse(ReadBody(context.Request));
                    payload = QaMainThreadDispatcher.Invoke(() => m_adapter.RemoveBlessing(request));
                }
                else if (context.Request.HttpMethod == "POST" && path == "/api/intents")
                {
                    var request = JObject.Parse(ReadBody(context.Request));
                    payload = QaMainThreadDispatcher.Invoke(() => m_adapter.ApplyIntents(request));
                }
                else
                {
                    WriteJson(context.Response, 404, new { error = "route_not_found" });
                    return;
                }

                WriteJson(context.Response, 200, payload);
            }
            catch (Exception exception)
            {
                WriteJson(context.Response, 500, new { error = exception.Message });
            }
        }

        private bool IsAuthorized(HttpListenerRequest request)
        {
            var value = request.Headers["Authorization"];
            return string.Equals(value, $"Bearer {m_token}", StringComparison.Ordinal);
        }

        private static string ReadBody(HttpListenerRequest request)
        {
            using var reader = new StreamReader(request.InputStream, request.ContentEncoding ?? Encoding.UTF8);
            return reader.ReadToEnd();
        }

        private void WriteJson(HttpListenerResponse response, int statusCode, object payload)
        {
            var json = JsonConvert.SerializeObject(payload, m_jsonSettings);
            var bytes = Encoding.UTF8.GetBytes(json);
            response.StatusCode = statusCode;
            response.ContentType = "application/json; charset=utf-8";
            response.ContentLength64 = bytes.Length;
            response.OutputStream.Write(bytes, 0, bytes.Length);
            response.OutputStream.Close();
        }

        private void Heartbeat()
        {
            if (EditorApplication.timeSinceStartup < m_nextHeartbeat)
            {
                return;
            }

            m_nextHeartbeat = EditorApplication.timeSinceStartup + 2d;
            WriteRendezvousFile();
        }

        private void WriteRendezvousFile()
        {
            var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AshesOfPantheonQA", "instances");
            Directory.CreateDirectory(directory);
            m_rendezvousPath = Path.Combine(directory, $"{m_instanceId}.json");
            var payload = new
            {
                instanceId = m_instanceId,
                kind = "editor",
                processId = Process.GetCurrentProcess().Id,
                displayName = $"Unity Editor · {Path.GetFileName(Directory.GetCurrentDirectory())}",
                gameVersion = Application.version,
                sceneName = SceneManager.GetActiveScene().name,
                port = m_port,
                token = m_token,
                lastSeenAt = DateTime.UtcNow.ToString("O")
            };
            File.WriteAllText(m_rendezvousPath, JsonConvert.SerializeObject(payload), new UTF8Encoding(false));
        }

        private static int ReservePort()
        {
            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            var port = ((IPEndPoint)listener.LocalEndpoint).Port;
            listener.Stop();
            return port;
        }

        private static string CreateToken()
        {
            var bytes = new byte[32];
            using var random = RandomNumberGenerator.Create();
            random.GetBytes(bytes);
            return string.Concat(bytes.Select(value => value.ToString("x2")));
        }

        private sealed class GmRequest
        {
            public string Command { get; set; }
        }
    }
}
