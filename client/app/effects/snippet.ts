import { Injectable } from '@angular/core';
import { Storage } from '@microsoft/office-js-helpers';
import { Observable } from 'rxjs/Observable';
import * as jsyaml from 'js-yaml';
import { PlaygroundError, AI, post, Strings, settings } from '../helpers';
import { Request, ResponseTypes, GitHubService } from '../services';
import { Action } from '@ngrx/store';
import { GitHub, Snippet, UI } from '../actions';
import { Effect, Actions } from '@ngrx/effects';
import cuid = require('cuid');
import { environment } from '../../environment';
import { Store } from '@ngrx/store';
import * as fromRoot from '../reducers';
import isEmpty = require('lodash/isEmpty');
import find = require('lodash/find');
import assign = require('lodash/assign');
import reduce = require('lodash/reduce');
import forIn = require('lodash/forIn');

@Injectable()
export class SnippetEffects {
    private _store = new Storage<ISnippet>(`playground_${environment.current.host}_snippets`);

    private _defaults = <ISnippet>{
        id: '',
        gist: '',
        source: environment.current.host,
        author: '',
        name: Strings.defaultSnippetTitle, // UI unknown
        description: '',
        script: { content: '', language: 'typescript' },
        style: { content: '', language: 'css' },
        template: { content: '', language: 'html' },
        libraries: ''
    };

    private _samplesRepoUrl = environment.current.config.samplesUrl;

    constructor(
        private actions$: Actions,
        private _request: Request,
        private _github: GitHubService,
        reduxStore: Store<fromRoot.State>,
    ) {
        this._defaults.author = this._github.profile ? this._github.profile.login : '';
        console.log(reduxStore);
        // this._store.notify = () => reduxStore.dispatch(new Snippet.LoadSnippetsAction());
    }

    @Effect({ dispatch: false })
    loggedIn$: Observable<Action> = this.actions$
        .ofType(GitHub.GitHubActionTypes.LOGGED_IN)
        .do(() => this._defaults.author = this._github.profile ? this._github.profile.login : '');

    @Effect()
    import$: Observable<Action> = this.actions$
        .ofType(Snippet.SnippetActionTypes.IMPORT)
        .map((action: Snippet.ImportAction) => ({ data: action.payload, suffix: action.params }))
        .mergeMap(({ data, suffix }) => {
            let observable: Observable<ISnippet>;
            let importType = this._determineImportType(data);
            let info = '';

            switch (importType) {
                case 'DEFAULT':
                    info = environment.current.host;
                    if (settings.cache.contains('default_template')) {
                        observable = Observable.of(settings.cache.get('default_template'));
                    }
                    else {
                        observable = this._request
                            .get<string>(`${this._samplesRepoUrl}/samples/${environment.current.host}/default.yaml`, ResponseTypes.YAML)
                            .map(snippet => settings.cache.insert('default_template', snippet));
                    }
                    break;

                case 'CUID':
                    info = data;
                    observable = Observable.of(this._store.get(data));
                    break;

                case 'GIST':
                    data = data.replace(/https:\/\/gist.github.com\/.*?\//, '');
                    observable = this._github.gist(data)
                        .map(gist => {
                            let snippet = find(gist.files, (value, key) => value ? /\.ya?ml$/gi.test(key) : false);
                            if (gist.public) {
                                info = gist.id;
                            }
                            if (snippet == null) {
                                let output = this._upgrade(gist.files);
                                output.description = '';
                                output.author = '';
                                output.source = '';
                                output.gist = data;
                                return output;
                            }
                            else {
                                return jsyaml.load(snippet.content);
                            }
                        });
                    break;

                case 'URL':
                    observable = this._request.get<string>(data, ResponseTypes.YAML);
                    break;

                case 'YAML':
                    let snippet = jsyaml.load(data);
                    info = snippet.id;
                    observable = Observable.of(snippet);
                    break;

                default: return null;
            }

            AI.trackEvent(Snippet.SnippetActionTypes.IMPORT, { type: importType, info: info });

            return observable
                .filter(snippet => !(snippet == null))
                .map(snippet => assign({}, this._defaults, snippet))
                .mergeMap(snippet => {
                    let external = importType !== 'CUID';
                    if (external) {
                        snippet.id = '';
                    }
                    if (snippet.id === '') {
                        snippet.id = cuid();
                    }

                    if (external && this._exists(snippet.name)) {
                        snippet.name = this._generateName(snippet.name, suffix);
                    }

                    return Observable.from([
                        new Snippet.ImportSuccessAction(snippet),
                    ]);
                });
        })
        .catch(exception => Observable.from([

            new UI.ReportErrorAction(Strings.snippetImportError, exception),
            new UI.ShowAlertAction({ message: Strings.snippetImportErrorBody, title: Strings.snippetImportErrorTitle, actions: [Strings.okButtonLabel] })

        ]));

    @Effect()
    save$: Observable<Action> = this.actions$
        .ofType(Snippet.SnippetActionTypes.SAVE, Snippet.SnippetActionTypes.CREATE)
        .map((action: Snippet.SaveAction) => action.payload)
        .map(snippet => {
            this._validate(snippet);
            snippet.lastModified = new Date().getTime();

            if (this._store.contains(snippet.id)) {
                this._store.insert(snippet.id, snippet);
            }
            else {
                this._store.add(snippet.id, snippet);
            }

            return new Snippet.StoreUpdatedAction();
        })
        .catch(exception => Observable.of(new UI.ReportErrorAction(Strings.snippetSaveError, exception)));

    @Effect()
    duplicate$: Observable<Action> = this.actions$
        .ofType(Snippet.SnippetActionTypes.DUPLICATE)
        .map((action: Snippet.DuplicateAction) => action.payload)
        .map(id => {
            let orignial = this._store.get(id);
            let copy: ISnippet = assign({}, this._defaults, orignial);
            copy.id = cuid();
            copy.name = this._generateName(copy.name, 'copy');
            return new Snippet.ImportSuccessAction(copy);
        })
        .catch(exception => Observable.of(new UI.ReportErrorAction(Strings.snippetDupeError, exception)));

    @Effect()
    delete$: Observable<Action> = this.actions$
        .ofType(Snippet.SnippetActionTypes.DELETE)
        .map((action: Snippet.DeleteAction) => action.payload)
        .map(id => this._store.remove(id))
        .mergeMap(() => Observable.from([
            new Snippet.StoreUpdatedAction(),
            new UI.ToggleImportAction(true)
        ]))
        .catch(exception => Observable.of(new UI.ReportErrorAction(Strings.snippetDeleteError, exception)));

    @Effect()
    deleteAll$: Observable<Action> = this.actions$
        .ofType(Snippet.SnippetActionTypes.DELETE_ALL)
        .map(() => this._store.clear())
        .map(() => new Snippet.StoreUpdatedAction())
        .catch(exception => Observable.of(new UI.ReportErrorAction(Strings.snippetDeleteAllError, exception)));

    @Effect()
    loadSnippets$: Observable<Action> = this.actions$
        .ofType(Snippet.SnippetActionTypes.STORE_UPDATED, Snippet.SnippetActionTypes.LOAD_SNIPPETS)
        .map(() => new Snippet.LoadSnippetsSuccessAction(this._store.values()))
        .catch(exception => Observable.of(new UI.ReportErrorAction(Strings.snippetLoadAllError, exception)));

    @Effect({ dispatch: false })
    run$: Observable<Action> = this.actions$
        .ofType(Snippet.SnippetActionTypes.RUN)
        .map(action => action.payload)
        .map((snippet: ISnippet) => {
            let returnUrl = window.location.href;
            if (environment.current.host === 'WEB') {
                returnUrl += '?mode=web';
            }

            let data = JSON.stringify({
                snippet: snippet,
                returnUrl: returnUrl,
                refreshUrl: window.location.origin + '/refresh.html',
                id: snippet.id,
                host: environment.current.host,
                platform: environment.current.platform
            });

            post(environment.current.config.runnerUrl, { data });
        })
        .catch(exception => Observable.of(new UI.ReportErrorAction(Strings.snippetRunError, exception)));

    @Effect()
    loadTemplates$: Observable<Action> = this.actions$
        .ofType(Snippet.SnippetActionTypes.LOAD_TEMPLATES)
        .map((action: Snippet.LoadTemplatesAction) => action.payload)
        .mergeMap(source => {
            if (source === 'LOCAL') {
                let snippetJsonUrl = `${this._samplesRepoUrl}/playlists/${environment.current.host}.yaml`;
                return this._request.get<ITemplate[]>(snippetJsonUrl, ResponseTypes.YAML);
            }
            else {
                return this._request.get<ITemplate[]>(source, ResponseTypes.JSON);
            }
        })
        .map(data => new Snippet.LoadTemplatesSuccessAction(data))
        .catch(exception => Observable.of(new UI.ReportErrorAction(Strings.snippetLoadDefaultsError, exception)));

    private _determineImportType(data: string): 'DEFAULT' | 'CUID' | 'URL' | 'GIST' | 'YAML' | null {
        if (data == null) {
            return null;
        }

        if (/^https:\/\/gist.github.com/.test(data)) {
            return 'GIST';
        }

        if (/^https?/.test(data)) {
            return 'URL';
        }

        if (data === 'default') {
            return 'DEFAULT';
        }

        if (data.length === 25) {
            return 'CUID';
        }

        if (data.length === 32) {
            return 'GIST';
        }

        return 'YAML';
    }

    private _exists(name: string) {
        return this._store.values().some(item => item.name.trim() === name.trim());
    }

    private _validate(snippet: ISnippet) {
        if (isEmpty(snippet)) {
            throw new PlaygroundError(Strings.snippetValidationEmpty);
        }

        if (isEmpty(snippet.name)) {
            throw new PlaygroundError(Strings.snippetValidationNoTitle);
        }
    }

    private _generateName(name: string, suffix: string = ''): string {
        let newName = isEmpty(name.trim()) ? Strings.newSnippetTitle : name.trim();
        let regex = new RegExp(`^${name}`);
        let options = this._store.values().filter(item => regex.test(item.name.trim()));
        let maxSuffixNumber = reduce(options, (max, item: any) => {
            let match = /\(?(\d+)?\)?$/.exec(item.name.trim());
            if (max <= ~~match[1]) {
                max = ~~match[1] + 1;
            }
            return max;
        }, 1);

        return `${newName}${(suffix ? ' - ' + suffix : '')}${(maxSuffixNumber ? ' - ' + maxSuffixNumber : '')}`;
    }

    private _upgrade(files: IGistFiles) {
        let snippet: ISnippet = {
            script: {
                content: '',
                language: 'typescript'
            },
            style: {
                content: '',
                language: 'css'
            },
            template: {
                content: '',
                language: 'html'
            },
            libraries: ''
        };

        forIn(files, (file, name) => {
            switch (name) {
                case 'libraries.txt':
                    snippet.libraries = file.content;
                    snippet.libraries = snippet.libraries.replace(/^\/\//gm, 'https://');
                    snippet.libraries = snippet.libraries.replace(/^#/gm, '//');
                    break;

                case 'app.ts':
                    snippet.script.content = file.content;
                    break;

                case 'index.html':
                    snippet.template.content = file.content;
                    break;

                case 'style.css':
                    snippet.style.content = file.content;
                    break;

                default:
                    if (!/\.json$/.test(name)) {
                        break;
                    }
                    snippet.name = JSON.parse(file.content).name;
                    break;
            }
        });

        AI.trackEvent('Upgrading snippet', { upgradeFrom: 'preview', upgradeTo: JSON.stringify(environment.current.build) });
        return snippet;
    }
}