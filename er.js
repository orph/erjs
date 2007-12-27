/* Er.js
 * Erlang-style concurrency and message passing library, using JavaScript 1.7.
 * Author: Alex Graveley, alex@beatniksoftware.com, http://beatniksoftware.com/
 *
 * Based on Thread.js
 * A library for threading using JavaScript 1.7 generators and trampolining.
 * Author: Neil Mix, neilmix [at] gmail [dot] com, http://www.neilmix.com/
 *
 * Please feel free to use this code in any way that pleases you.  If
 * appropriate, drop me an email because I like hearing about interesting 
 * projects.
 */


// Use this in message matching patterns passed to Er.register in
// order to match any value for a message key.  '_' can also be used
// as the key name to match any key.
var _ = 0xDEADBEEF;


var Er = {
   /* 
    * Public API...
    */

   // Linked processes send this Signal value to their links 
   // when exiting.  The message is of the form: 
   //   { Signal: Er.Exit, From: <exiting pid>, Reason: <reason> }
   Exit: { toString: function() { return "[object Er.Exit]" } },

   // Regular process exit uses this as the Reason value.
   Normal: { toString: function() { return "[object Er.Normal]" } },

   // Start a function in a new process, optionally passing
   // arguments.  The function can be a generator.  If no arguments
   // are specified, [] is passed.  Usage:
   //   pid = Er.spawn(function () { ... } [, args...])
   spawn: function(fun) {
      var args = Array.prototype.slice.call(arguments, 1);
      return Er._addproc(fun, args, null)._pid;
   },

   // Same as Er.spawn, but link the current process to the spawned 
   // process' exit signal.  Usage:
   //   pid = Er.spawn_link(function () { ... } [, args...])
   spawn_link: function(fun) {
      var args = Array.prototype.slice.call(arguments, 1);
      return Er._addproc(fun, args, Er._current._pid)._pid;
   },

   // Get the current process pid
   pid: function() {
      return Er._current._pid;
   },

   // Register a pid to receive messages sent to a name string.  
   // Multiple processes can register the same name, and a process
   // can have multiple registered names.
   register: function(name, pid) {
      if (!Er._names[name])
         Er._names[name] = [];
      if (!(pid in Er._names[name]))
         Er._names[name].push(pid);
   },

   // Return a list of pids registered to a name.
   registered: function(name) {
      return Er._names[name];
   },

   // Send a message, in the form of an associative array to the /
   // given pid or registered name.  The msg argument is always
   // returned. Usage:
   //    msg = Er.send(<pid|name>, { Key: Value, ... });
   send: function(id, msg) {
      Er._pidof(id).forEach(function(pid) {
         Er._pids[pid]._send(msg);
      });
      return msg;
   },

   // Link the current process to id's exit signal, where id is a pid
   // or registered name.
   link: function(id) {
      Er._pidof(id).forEach(function(pid) {
         Er._linkpids(pid, Er._current._pid);
      });
   },

   // Unlink the current process from id's exit signal.
   unlink: function(id) {
      Er._pidof(id).forEach(function(pid) {
         delete Er._links[pid][Er._current._pid];
      });
   },

   // Exit the current process, with optional exit Reason, passed to
   // linked processes.  If no reason is specified, normal exit is
   // assume, and do not messages sent.
   exit: function() {
      Er._current._exit(
         (arguments.length > 0 && arguments[0]) || Er.Normal);
   },

   /* NOTE: Requires yield.  Receive a single message sent to this
    * pid, by matching a list of patterns against an incoming
    * message.  Patterns are followed by a handler function, listed
    * after patterns.  The final return value is the return value of
    * the invoked handler.  Usage:
    *   val = yield Er.receive(
    *         // List of patterns to match
    *      { MyKey: 123 },      // Explicit matches...
    *      { MyKey: "abc" },    // ... Strings
    *      { MyKey: obj },      // ... References
    *      { MyKey: TypeName }, // Instance of a type 
    *      { MyKey: { ... } },  // Nested matching
    *      { MyKey: _ },        // Any value
    *         // Handler function follows patterns
    *      function(msg) { alert(msg.MyKey); },
    *         // More patterns/handlers
    *      { A: ..., B: ... },  // Multiple keys
    *      { _: ... },          // Any keyname
    *      { _: _ },            // Any key, any value
    *      function(msg) { ... });
    */
   receive: function() {
      yield Er._current._receive(arguments);
   },

   // NOTE: Requires yield.  Sleep a number of milliseconds before
   // continuing the process.  Usage:
   //   yield Er.sleep(1000); // 1 second
   sleep: function(millis) {
      if (Er._current == Er._mainproc)
         throw("Er: Cannot sleep inside the main process!");
      yield Er._current._sleep(millis);
   },

   /*
    * Private ErProc, links, and registered name helpers...
    */

   _pids: [],  // [pid] = ErProc instance
   _names: {}, // [name] = [pid, ...]
   _links: [], // [pid] = [dest_pid, ...]
   _mainproc: null,
   _current: null,

   // Start the main process.  This is pid 0.
   _init: function() {
      Er._mainproc = Er._current = Er._addproc(function() {
         while (true) {
            // Hang around to receive messages.
            yield Er.sleep(10000);
         }
      }, null, null);
   },

   // Create and run a new ErProc process which will call fun(args),
   // possibly creating an initial link to link_pid.
   _addproc: function(fun, args, link_pid) {
      var newpid = Er._pids.length;
      var newproc = new ErProc(newpid, fun, args);

      Er._pids[newpid] = newproc;

      delete Er._links[newpid];
      if (link_pid)
         Er._linkpids(newpid, link_pid);

      newproc._start();
      return newproc;
   },

   // Cleanup after pid exits, sending exit messages to linked
   // processes.
   _removeproc: function(pid, exitreason) {
      delete Er._pids[pid];

      for (var name in Er._names) {
         if (pid in Er._names[name])
            delete Er._names[name][pid];
      }

      var outlinks = Er._links[pid] || [];
      delete Er._links[pid];

      if (exitreason && exitreason != Er.Normal) {
         for (var i in outlinks) {
            if (outlinks[i] == true) {
               Er.send(parseInt(i), { Signal: Er.Exit,
                                      From: pid,
                                      Reason: exitreason });
            }
         }
      }
   },

   // Get the list of pids for a given registered name.  Passing a
   // pid or ErProc will do the obvious.
   _pidof: function(id) {
      if (typeof(id) == "number" || id instanceof Number) {
         if (!(id in Er._pids))
            return []; // Ignore missing pids
         return [id];
      } else if (id instanceof ErProc) {
         return [id._pid];
      } else {
         if (!(id in Er._names))
            throw("Er: Process name not registered: " + 
                  id + " (" + typeof(id) + ")");
         return Er._names[id];
      }
   },

   // Link pid to dest_pid, so that when pid exits, dest_pid will
   // recieve it's exit signal.
   _linkpids: function(pid, dest_pid) {
      if (!Er._links[pid])
         Er._links[pid] = [];
      Er._links[pid][dest_pid] = true;
   },
};


function ErProc(pid, fun, args) {
   this._pid = pid;
   this._queue = [];
   this._stack = [];

   var _this = this;
   this._resumeDelegate = function(retval) {
      _this._run(retval, false);
   };
   this._start = function() {
      _this._run(_this._threadmain(fun, args), false);
   };
}
ErProc.prototype = {
   constructor: ErProc,

   /*
    * Callbacks from Er on the current ErProc...
    */

   // Start running fun(args), and yield the result.  Catch exceptions and use
   // as the exitreason sent to Er._removeproc.
   _threadmain: function(fun, args) {
      // Wait until the document is loaded.
      while (!document.body) {
         yield Er.sleep(100);
      }

      var retval;
      try {
         retval = (yield fun.apply({}, args));
      } catch(e if e == StopIteration) {
         retval = undefined;
      } catch(e) {
         retval = e;
      }

      Er._removeproc(this._pid, retval);
   },

   // Just throw the reason for the process _threadmain to catch.
   _exit: function(reason) {
      throw reason;
   },

   // See Er.receive description for what this is supposed to do.  Hashtable
   // match requires matching all submembers, unless a '_' key is specified.
   // Arrays match any one submember matching.
   _match: function(pattern, value) {
      if (pattern == _ ||
          pattern == value ||
          pattern == value.constructor)
         return true;

      if (!value instanceof Object)
         return false;

      if (pattern instanceof Array) {
         for (var idx in pattern) {
            for (var vidx in value) {
               if (this._match(pattern[idx], value[vidx]))
                  return true;
            }
            return false;
         }
         return value.length == 0;
      } else {
         var match_any = "_" in pattern;
         for (var name in pattern) {
            if (!match_any && !value.hasOwnProperty(name))
               return false;
            if (!this._match(pattern[name], value[name]))
               return false;
         }
      }

      return true;
   },

   // Collect patterns/handlers and read messages off the queue until a match is
   // found.  Call the pattern's handler and yield the result.
   _receive: function(args) {
      var patterns = [];

      try {
         for (var i = 0; i < args.length; i++) {
            var patlist = [];
            var handler = null;

            for (; i < args.length; i++) {
               if (typeof(args[i]) == "function") {
                  handler = args[i];
                  break;
               } else {
                  patlist.push(args[i]);
               }
            }

            if (patlist.length == 0)
               throw("Er.receive: found no patterns");
            if (handler == null)
               throw("Er.receive: no handler for patterns");

            for (var j = 0; j < patlist.length; j++) {
               patterns.push([patlist[j], handler]);
            }
         }
      } catch (e) {
         throw("Er.receive: unexpected error in arguments: " + e);
      }

      if (!patterns.length)
         throw("Er.receive: no valid patterns!");

      var done = false;
      var retmsg = null;
      var pending = [];

   loop:
      while (!done) {
         var msg;
         while ((msg = this._queue.shift())) {
            for (var i = 0; i < patterns.length; i++) {
               if (this._match(patterns[i][0], msg)) {
                  retmsg = patterns[i][1](msg);
                  done = true;
                  break loop;
               }
            }

            // Unhandled link exit. Exit this process too.
            if (msg.Signal == Er.Exit && msg.Reason != Er.Normal) {
               Er.exit(msg.Reason);
            }

            pending.push(msg);
         }

         // Give the queue a chance to fill again / avoid starving others
         yield Er.sleep(100);
      }

      this._queue = pending.concat(this._queue);
      yield retmsg;
   },

   _send: function(msg) {
      this._queue.push(msg || {});
   },

   _sleep: function(millis) {
      setTimeout((yield this._CONTINUATION), millis);
      yield this._SUSPEND;
   },

   /* special yield value which tells a Thread to suspend execution */
   _SUSPEND: { toString: function() { return "[object ErProc._SUSPEND]" } },

   /* special yield value which tells a Thread to send a continuation callback
    * for resuming a thread */
   _CONTINUATION: { toString: function() { return "[object ErProc._CONTINUATION]" } },

   /* special yield value which tells a Thread to send the Thread object itself */
   _THREAD: { toString: function() { return "[object ErProc._THREAD]" } },

   // Execute this ErProc using trampolining... this is copied
   // directly from Threads.js.  Changed to always set/unset the
   // Er._current global.
   _run: function(retval, isException) {
      while (true) {
         var method;
         var arg = undefined;
         if (isException) {
            this._stack.pop().close();
            if (this._stack.length) {
               // propagate the exception down the stack
               method = "throw";
               arg    = retval;
            } else {
               // we're done
               return;
            }
         } else if (retval == this._THREAD) {
            // generator is requesting this thread object
            method = "send";
            arg    = this;
         } else if (retval == this._CONTINUATION) {
            // generator is requesting our resume callback
            method = "send";
            arg    = this._resumeDelegate;
         } else if (retval == this._SUSPEND) {
            // generator has requested we suspend
            return;
         } else if (retval != null && 
                    typeof(retval) == "object" &&
                    typeof(retval.next) == "function" && 
                    typeof(retval.send) == "function") {
            // it's a generator that was returned.
            // add it as a new frame on the stack.
            this._stack.push(retval);
            method = "next";
         } else {
            // regular return value
            // end the current frame
            this._stack.pop().close();
            if (this._stack.length) {
               // return to the previous frame
               method = "send";
               arg    = retval;
            } else {
               // we're done.
               return;
            }
         }

         // Always set the current Er process before invoking callbacks.
         // Always revert it back once we return.
         var lastproc = Er._current;
         Er._current = this;
         try {
            retval = this._stack[this._stack.length-1][method](arg);
            isException = false;
         } catch(e if e == StopIteration) {
            // since a normal return results in StopIteration, we'll
            // just treat this as a return
            isException = false;
         } catch(e) {
            retval = e;
            isException = true;
         } finally {
            Er._current = lastproc;
         }
      }
   },
};


// Start the main process.
Er._init();


Er.AjaxOptions = function() { };
Er.AjaxOptions.prototype = {
   Username: null,
   Password: null,
   Method: null,         // Override POST with data, GET without
   Request: {
      Headers: { },      // Header: value to send
      ContentType: null, // Override "application/x-www-form-urlencoded"
   },
   Response: {
      Headers: [],       // List of header names to return
      ContentType: null, // Override server's Content-Type
   },
   Timeout: 0,
   UseCache: false,
   IfModified: true,     // Set La
   NotifyHeaders: false,
   NotifyPartial: false
};


Er.Ajax = {
   DefaultOptions: new Er.AjaxOptions(),

   _lastModified: {}, // url: date-string

   // NOTE: Requires yield.  Er.Ajax.spawn wrapper to POST to a URL
   // (pseudo-)synchronously.  Waits until receiving a message from
   // the spawn'd process with the Success field set, and returns
   // that message.
   post: function(url, data, options) {
      var pid = Er.Ajax.spawn(Er.pid(), url, data, options);
      yield Er.receive({ From: pid, Success: _, _:_ },
                       function(msg) { return msg; });
   },

   // NOTE: Requires yield.  Like Er.Ajax.post, but GET content.
   get: function(url, options) {
      yield Er.Ajax.post(url, null, options);
   },

   /* NOTE: Requires yield.  Spawn a new process to download URL,
    * possibly POSTing data.  Er.Ajax.DefaultOptions are used if no
    * options are specified.
    * The pid arg will receive messages of the form: 
    *    { From:       Spawn'd Pid
    *      Url:        URL,
    *      Success:    true/false if finished,
    *      Text:       URL body text
    *      XmlDoc:     XMLDocument if response is XML
    *      Status:     HTTP status code,
    *      StatusText: HTTP status text,
    *      Headers:    { Optional response headers name/val } }
    * The final message will have a Success boolean set, and the
    * process will exit normally regardless of Success.  Usage: 
    *    pid = yield Er.Ajax.spawn(pid, url, [, data [, Er.AjaxOptions]]);
    */
   spawn: function(from, url, data, options) {
      return Er.spawn(function (from, url, data, options) {
         // Create the request object; Microsoft failed to properly implement the
         // XMLHttpRequest in IE7, so we use the ActiveXObject when it is available
         var xml = new XMLHttpRequest();

         // Open the socket (async)
         xml.open(options.Method || (data ? "POST" : "GET"), url, true, 
                  options.Username, options.Password);

         var _pid = Er.pid();
         xml.onreadystatechange = function() {
            if (!xml || (xml.readyState == 2 && !options.NotifyHeaders) ||
                (xml.readyState == 3 && !options.NotifyPartial) ||
                xml.readyState != 4)
               return;

            var msg = { From: _pid,
                        Url: url,
                        Status: xml.status,
                        StatusText: xml.statusText,
                        Text: xml.responseText };

            if (options.Response.Headers.length) {
               msg.Headers = {};
               for (header in options.Response.Headers)
                  msg.Headers[header] = xml.getResponseHeader(header);
            }

            // Update last-modified cache
            var lm = Er.Ajax._lastModified[url];
            try { lm = xml.getResponseHeader("Last-Modified") } catch (e) {}
            if (options.IfModified && lm)
               Er.Ajax._lastModified[url] = lm;

            if (xml.readyState == 4) {
               // Get the finished xml document
               var ct = options.Response.ContentType;
               try { ct = xml.getResponseHeader("content-type") } catch (e) {}
               if (ct && ct.indexOf("xml") >= 0)
                  msg.XmlDoc = xml.responseXML;

               msg.Success = (!xml.status && location.protocol == "file:") ||
                  (xml.status >= 200 && xml.status < 300 ) ||
                  xml.status == 304;

               Er.send(_pid, { Done: true });
               xml = null;
            }

            Er.send(from, msg);
         };

         // Set the If-Modified-Since header, if ifModified mode.
         if (options.IfModified)
            xml.setRequestHeader("If-Modified-Since",
               Er.Ajax._lastModified[url] || "Thu, 01 Jan 1970 00:00:00 GMT" );

         // Set header so the called script knows that it's an XMLHttpRequest
         xml.setRequestHeader("X-Requested-With", "XMLHttpRequest");

         // Set user-specified headers
         for (header in options.Request.Headers)
            xml.setRequestHeader(header, options.Request.Headers[header]);

         // Set the correct header, if data is being sent
         if (data)
            xml.setRequestHeader("Content-Type", 
               options.Request.ContentType || "application/x-www-form-urlencoded");

         // XXX: format data
         xml.send(data);

         yield Er.receive({ Done: true },
                          function(msg) {
                             Er.exit();
                          },
                          { Cancel: true },
                          function(msg) {
                             if (xml) {
                                xml.abort();
                                xml = null;
                             }
                             Er.exit(msg);
                          });
      }, from, url, data, options || Er.Ajax.DefaultOptions);
   }
};
